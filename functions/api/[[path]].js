const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
};

export default {
    async fetch(request, env) {
        if (request.method === 'OPTIONS') {
            return new Response(null, { headers: CORS_HEADERS });
        }

        const url = new URL(request.url);
        const path = url.pathname;
        const group = url.searchParams.get('group') || 'MFG';

        try {
            // ===== 班长管理 =====
            if (path === '/api/leaders' && request.method === 'GET') {
                const results = await env.DB.prepare('SELECT * FROM leaders WHERE group_name = ? ORDER BY created_at ASC').bind(group).all();
                return json(results.results);
            }

            if (path === '/api/leaders' && request.method === 'POST') {
                const { name, shift, group_name } = await request.json();
                if (!name) return json({ error: '请输入班长姓名' }, 400);
                try {
                    await env.DB.prepare('INSERT INTO leaders (name, shift, group_name) VALUES (?, ?, ?)').bind(name, shift || 'D', group_name || 'MFG').run();
                    return json({ success: true, message: '班长已添加' });
                } catch (e) {
                    return json({ error: '该班长已存在' }, 400);
                }
            }

            if (path.startsWith('/api/leaders/') && request.method === 'DELETE') {
                const id = path.split('/').pop();
                await env.DB.prepare('DELETE FROM leaders WHERE id = ?').bind(id).run();
                return json({ success: true, message: '已删除' });
            }

            // ===== 任务管理 =====
            if (path === '/api/tasks' && request.method === 'GET') {
                const results = await env.DB.prepare('SELECT * FROM tasks WHERE group_name = ? ORDER BY created_at DESC').bind(group).all();
                const tasks = results.results.map(t => ({
                    ...t,
                    progress: JSON.parse(t.progress || '[]'),
                    transfer_history: JSON.parse(t.transfer_history || '[]')
                }));
                return json(tasks);
            }

            if (path === '/api/tasks' && request.method === 'POST') {
                const { tasks: newTasks, handover, group_name } = await request.json();
                const g = group_name || 'MFG';
                const stmts = newTasks.map(t =>
                    env.DB.prepare(
                        'INSERT INTO tasks (task_id, shift, from_leader, to_leader, title, description, area, priority, category, status, progress, transfer_history, group_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
                    ).bind(
                        t.taskId, t.shift, t.fromLeader, t.toLeader,
                        t.title, t.description || '', t.area || 'CAS',
                        t.priority || 'medium', t.category || 'other',
                        'pending', '[]', '[]', g
                    )
                );
                if (handover) {
                    stmts.push(
                        env.DB.prepare(
                            'INSERT INTO handovers (shift, from_leader, to_leader, task_count, group_name) VALUES (?, ?, ?, ?, ?)'
                        ).bind(handover.shift, handover.fromLeader, handover.toLeader, handover.taskCount, g)
                    );
                }
                await env.DB.batch(stmts);
                return json({ success: true, message: '提交成功', count: newTasks.length });
            }

            if (path.startsWith('/api/tasks/') && request.method === 'PUT') {
                const id = path.split('/').pop();
                const updates = await request.json();
                const current = await env.DB.prepare('SELECT * FROM tasks WHERE task_id = ?').bind(id).first();
                if (!current) return json({ error: '任务不存在' }, 404);

                let progress = JSON.parse(current.progress || '[]');
                let transferHistory = JSON.parse(current.transfer_history || '[]');
                let newStatus = current.status;
                let newToLeader = current.to_leader;
                let newFromLeader = current.from_leader;

                if (updates.status) {
                    progress.push({
                        time: new Date().toISOString(),
                        content: '状态确认: ' + statusName(current.status) + ' → ' + statusName(updates.status)
                    });
                    newStatus = updates.status;
                }

                if (updates.transfer) {
                    transferHistory.push({
                        from: updates.transfer.from,
                        to: updates.transfer.to,
                        time: new Date().toISOString(),
                        reason: updates.transfer.reason || ''
                    });
                    progress.push({
                        time: new Date().toISOString(),
                        content: '任务转交: ' + updates.transfer.from + ' → ' + updates.transfer.to +
                            (updates.transfer.reason ? ' (' + updates.transfer.reason + ')' : '')
                    });
                    newStatus = 'pending';
                    newToLeader = updates.transfer.to;
                    newFromLeader = updates.transfer.from;
                }

                await env.DB.prepare(
                    "UPDATE tasks SET status = ?, to_leader = ?, from_leader = ?, progress = ?, transfer_history = ?, updated_at = datetime('now') WHERE task_id = ?"
                ).bind(
                    newStatus, newToLeader, newFromLeader,
                    JSON.stringify(progress), JSON.stringify(transferHistory), id
                ).run();

                return json({ success: true });
            }

            if (path === '/api/tasks/clear' && request.method === 'POST') {
                const body = await request.json().catch(() => ({}));
                const g = body.group_name || 'MFG';
                await env.DB.batch([
                    env.DB.prepare('DELETE FROM tasks WHERE group_name = ?').bind(g),
                    env.DB.prepare('DELETE FROM handovers WHERE group_name = ?').bind(g)
                ]);
                return json({ success: true, message: g + '组任务数据已清空，班长名单已保留' });
            }

            // ===== 交接记录 =====
            if (path === '/api/handovers' && request.method === 'GET') {
                const results = await env.DB.prepare('SELECT * FROM handovers WHERE group_name = ? ORDER BY created_at DESC').bind(group).all();
                return json(results.results);
            }

            if (path === '/api/health') {
                return json({ status: 'ok', time: new Date().toISOString() });
            }

            return json({ error: 'Not Found' }, 404);

        } catch (err) {
            return json({ error: err.message }, 500);
        }
    }
};

function json(data, status = 200) {
    return new Response(JSON.stringify(data), { status, headers: CORS_HEADERS });
}

function statusName(s) {
    const map = { pending: '待处理', 'in-progress': '进行中', completed: '已完成', transferred: '已转交' };
    return map[s] || s;
}
