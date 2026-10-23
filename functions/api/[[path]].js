const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
};
function R(data, status=200){return new Response(JSON.stringify(data),{status,headers:CORS});}
function sName(s){return{pending:'待处理','in-progress':'进行中',completed:'已完成',transferred:'已转交'}[s]||s;}

export async function onRequest({request, env}){
    if(request.method==='OPTIONS') return new Response(null,{headers:CORS});
    const url = new URL(request.url);
    const path = url.pathname;
    const group = url.searchParams.get('group') || 'MFG';
    const DB = env.DB;

    try{
        if(path==='/api/health'){
            return R({status:'ok',time:new Date().toISOString()});
        }
        if(path==='/api/leaders' && request.method==='GET'){
            const r = await DB.prepare('SELECT * FROM leaders WHERE group_name = ? ORDER BY created_at ASC').bind(group).all();
            return R(r.results);
        }
        if(path==='/api/leaders' && request.method==='POST'){
            const {name,shift,group_name} = await request.json();
            if(!name) return R({error:'请输入班长姓名'},400);
            try{
                await DB.prepare('INSERT INTO leaders (name,shift,group_name) VALUES (?,?,?)').bind(name,shift||'D',group_name||'MFG').run();
                return R({success:true});
            }catch(e){ return R({error:'该班长已存在'},400); }
        }
        if(path.startsWith('/api/leaders/') && request.method==='DELETE'){
            const id = path.split('/').pop();
            await DB.prepare('DELETE FROM leaders WHERE id=?').bind(id).run();
            return R({success:true});
        }
        if(path==='/api/tasks' && request.method==='GET'){
            const r = await DB.prepare('SELECT * FROM tasks WHERE group_name = ? ORDER BY created_at DESC').bind(group).all();
            const tasks = r.results.map(t=>({
                ...t,
                progress: JSON.parse(t.progress||'[]'),
                transfer_history: JSON.parse(t.transfer_history||'[]')
            }));
            return R(tasks);
        }
        if(path==='/api/tasks' && request.method==='POST'){
            const {tasks:newTasks, handover, group_name} = await request.json();
            const g = group_name || 'MFG';
            const stmts = newTasks.map(t=>
                DB.prepare('INSERT INTO tasks (task_id,shift,from_leader,to_leader,title,description,area,priority,category,status,progress,transfer_history,group_name) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
                .bind(t.taskId,t.shift,t.fromLeader,t.toLeader,t.title,t.description||'',t.area||'CAS',t.priority||'medium',t.category||'other','pending','[]','[]',g)
            );
            if(handover){
                stmts.push(DB.prepare('INSERT INTO handovers (shift,from_leader,to_leader,task_count,group_name) VALUES (?,?,?,?,?)').bind(handover.shift,handover.fromLeader,handover.toLeader,handover.taskCount,g));
            }
            await DB.batch(stmts);
            return R({success:true,count:newTasks.length});
        }
        if(path==='/api/tasks/clear' && request.method==='POST'){
            const body = await request.json().catch(()=>({}));
            const g = body.group_name || 'MFG';
            await DB.batch([
                DB.prepare('DELETE FROM tasks WHERE group_name = ?').bind(g),
                DB.prepare('DELETE FROM handovers WHERE group_name = ?').bind(g)
            ]);
            return R({success:true,message:g+'组任务数据已清空，班长名单已保留'});
        }
        if(path.startsWith('/api/tasks/') && request.method==='PUT'){
            const id = path.split('/').pop();
            const updates = await request.json();
            const current = await DB.prepare('SELECT * FROM tasks WHERE task_id=?').bind(id).first();
            if(!current) return R({error:'任务不存在'},404);
            let progress = JSON.parse(current.progress||'[]');
            let transferHistory = JSON.parse(current.transfer_history||'[]');
            let newStatus = current.status, newTo = current.to_leader, newFrom = current.from_leader;
            if(updates.status){
                progress.push({time:new Date().toISOString(),content:'状态确认: '+sName(current.status)+' → '+sName(updates.status)});
                newStatus = updates.status;
            }
            if(updates.transfer){
                transferHistory.push({from:updates.transfer.from,to:updates.transfer.to,time:new Date().toISOString(),reason:updates.transfer.reason||''});
                progress.push({time:new Date().toISOString(),content:'任务转交: '+updates.transfer.from+' → '+updates.transfer.to+(updates.transfer.reason?' ('+updates.transfer.reason+')':'')});
                newStatus='pending'; newTo=updates.transfer.to; newFrom=updates.transfer.from;
            }
            await DB.prepare("UPDATE tasks SET status=?,to_leader=?,from_leader=?,progress=?,transfer_history=?,updated_at=datetime('now') WHERE task_id=?")
                .bind(newStatus,newTo,newFrom,JSON.stringify(progress),JSON.stringify(transferHistory),id).run();
            return R({success:true});
        }
        if(path==='/api/handovers' && request.method==='GET'){
            const r = await DB.prepare('SELECT * FROM handovers WHERE group_name = ? ORDER BY created_at DESC').bind(group).all();
            return R(r.results);
        }
        return R({error:'Not Found'},404);
    }catch(err){
        return R({error:err.message},500);
    }
}
