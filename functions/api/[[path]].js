const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
};

function R(data, status=200){
    return new Response(JSON.stringify(data),{status,headers:CORS});
}

function sName(s){
    return{pending:'待处理','in-progress':'进行中',completed:'已完成',transferred:'已转交'}[s]||s;
}

export async function onRequest({request, env, params}){
    if(request.method==='OPTIONS') return new Response(null,{headers:CORS});
    
    const url = new URL(request.url);
    const path = url.pathname;
    const DB = env.DB;

    try{
        // 健康检查
        if(path==='/api/health'){
            return R({status:'ok',time:new Date().toISOString()});
        }

        // 班长列表
        if(path==='/api/leaders' && request.method==='GET'){
            const r = await DB.prepare('SELECT * FROM leaders ORDER BY created_at ASC').all();
            return R(r.results);
        }

        // 添加班长
        if(path==='/api/leaders' && request.method==='POST'){
            const {name,shift} = await request.json();
            if(!name) return R({error:'请输入班长姓名'},400);
            try{
                await DB.prepare('INSERT INTO leaders (name,shift) VALUES (?,?)').bind(name,shift||'D').run();
                return R({success:true});
            }catch(e){
                return R({error:'该班长已存在'},400);
            }
        }

        // 删除班长
        if(path.startsWith('/api/leaders/') && request.method==='DELETE'){
            const id = path.split('/').pop();
            await DB.prepare('DELETE FROM leaders WHERE id=?').bind(id).run();
            return R({success:true});
        }

        // 任务列表
        if(path==='/api/tasks' && request.method==='GET'){
            const r = await DB.prepare('SELECT * FROM tasks ORDER BY created_at DESC').all();
            const tasks = r.results.map(t=>({
                ...t,
                progress: JSON.parse(t.progress||'[]'),
                transfer_history: JSON.parse(t.transfer_history||'[]')
            }));
            return R(tasks);
        }

        // 创建任务
        if(path==='/api/tasks' && request.method==='POST'){
            const {tasks:newTasks, handover} = await request.json();
            const stmts = newTasks.map(t=>
                DB.prepare('INSERT INTO tasks (task_id,shift,from_leader,to_leader,title,description,area,priority,category,status,progress,transfer_history) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
                .bind(t.taskId,t.shift,t.fromLeader,t.toLeader,t.title,t.description||'',t.area||'CAS',t.priority||'medium',t.category||'other','pending','[]','[]')
            );
            if(handover){
                stmts.push(DB.prepare('INSERT INTO handovers (shift,from_leader,to_leader,task_count) VALUES (?,?,?,?)').bind(handover.shift,handover.fromLeader,handover.toLeader,handover.taskCount));
            }
            await DB.batch(stmts);
            return R({success:true,count:newTasks.length});
        }

        // 清空任务
        if(path==='/api/tasks/clear' && request.method==='POST'){
            await DB.batch([
                DB.prepare('DELETE FROM tasks'),
                DB.prepare('DELETE FROM handovers')
            ]);
            return R({success:true,message:'任务数据已清空，班长名单已保留'});
        }

        // 更新任务
        if(path.startsWith('/api/tasks/') && request.method==='PUT'){
            const id = path.split('/').pop();
            const updates = await request.json();
            const current = await DB.prepare('SELECT * FROM tasks WHERE task_id=?').bind(id).first();
            if(!current) return R({error:'任务不存在'},404);

            let progress = JSON.parse(current.progress||'[]');
            let transferHistory = JSON.parse(current.transfer_history||'[]');
            let newStatus = current.status;
            let newTo = current.to_leader;
            let newFrom = current.from_leader;

            if(updates.status){
                progress.push({time:new Date().toISOString(),content:'状态确认: '+sName(current.status)+' → '+sName(updates.status)});
                newStatus = updates.status;
            }
            if(updates.transfer){
                transferHistory.push({from:updates.transfer.from,to:updates.transfer.to,time:new Date().toISOString(),reason:updates.transfer.reason||''});
                progress.push({time:new Date().toISOString(),content:'任务转交: '+updates.transfer.from+' → '+updates.transfer.to+(updates.transfer.reason?' ('+updates.transfer.reason+')':'')});
                newStatus='pending';
                newTo=updates.transfer.to;
                newFrom=updates.transfer.from;
            }

            await DB.prepare("UPDATE tasks SET status=?,to_leader=?,from_leader=?,progress=?,transfer_history=?,updated_at=datetime('now') WHERE task_id=?")
                .bind(newStatus,newTo,newFrom,JSON.stringify(progress),JSON.stringify(transferHistory),id).run();
            return R({success:true});
        }

        // 交接记录
        if(path==='/api/handovers' && request.method==='GET'){
            const r = await DB.prepare('SELECT * FROM handovers ORDER BY created_at DESC').all();
            return R(r.results);
        }

        return R({error:'Not Found'},404);

    }catch(err){
        return R({error:err.message},500);
    }
}
