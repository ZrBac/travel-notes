/* Presentation for the private travel workspace. Reuses existing APIs and actions. */
const AdminWorkspace = (() => {
  const groups = [
    {title: '我的出行', items: [['dashboard', 'grid', '工作台'], ['trips', 'compass', '我的旅行'], ['travel-agent', 'spark', '旅游助手']]},
    {title: '旅行档案', items: [['guides', 'book', '攻略管理'], ['records', 'pin', '旅行足迹'], ['media', 'image', '图片素材']]},
    {title: '设置与维护', collapsible: true, items: [['taxonomy', 'tag', '分类与标签'], ['agent', 'settings', '网站管家'], ['settings', 'sliders', '站点设置'], ['data', 'data', '数据与备份'], ['audit', 'clock', '操作记录'], ['account', 'user', '管理员账号']]}
  ];
  const aliases = {'trip': 'trips', 'trip-new': 'trips', 'edit': 'guides', 'new': 'guides', 'import': 'guides', 'trash': 'guides', 'record-edit': 'records', 'record-new': 'records', 'record-trash': 'records'};
  const titles = {dashboard: '旅行工作台', guides: '攻略管理', trash: '攻略回收站', records: '旅行足迹', 'record-trash': '足迹回收站', media: '图片素材', taxonomy: '分类与标签', 'travel-agent': '旅游助手', agent: '网站管家', settings: '站点设置', data: '数据与备份', audit: '操作记录', account: '管理员账号', edit: '编辑攻略', new: '新建攻略', 'record-edit': '编辑旅行足迹', 'record-new': '记录旅行足迹'};
  const viewOf = route => route.split(/[/?]/)[0];
  const active = route => aliases[viewOf(route)] || viewOf(route);
  function meta(view) {
    const key = active(view), group = groups.find(g => g.items.some(item => item[0] === key));
    const label = group?.items.find(item => item[0] === key)?.[2] || '工作台';
    const child = {'edit': '编辑攻略', 'new': '新建攻略', 'trash': '回收站', 'import': '导入攻略', 'record-edit': '编辑足迹', 'record-new': '新建足迹', 'record-trash': '回收站', 'trip-new': '安排出行', 'trip': '旅行详情'}[view];
    return {key, label, breadcrumb: child ? label + ' / ' + child : label};
  }
  function navigation(view) {
    const selected = active(view);
    const link = ([key, name, label]) => `<a class="nav-item ${selected === key ? 'active' : ''}" href="#${key}" ${selected === key ? 'aria-current="page"' : ''}>${icon(name)}<span>${label}</span></a>`;
    return groups.map((group, i) => {
      const links = `<div class="nav-group-items">${group.items.map(link).join('')}</div>`;
      return group.collapsible
        ? `<details class="nav-group nav-system" ${group.items.some(item => item[0] === selected) ? 'open' : ''}><summary>${group.title}<span class="nav-chevron" aria-hidden="true"></span></summary>${links}</details>`
        : `<section class="nav-group" aria-labelledby="nav-group-${i}"><h2 id="nav-group-${i}">${group.title}</h2>${links}</section>`;
    }).join('');
  }
  function currentTrip(t) {
    if (!t) return `<section class="panel trip-focus journey-hero"><span class="journey-kicker">我的旅行 <span>仅管理员可见</span></span><div class="journey-hero-copy"><h2>准备下一次出发</h2><p>让助手整理灵感，选好方案后，把预约、行李和每天的路线放进这趟旅行。</p></div><div class="actions"><a class="button primary" href="#travel-agent">${icon('spark')}让助手规划</a><a class="button" href="#trip-new">从已有想法开始 ${icon('arrow')}</a></div><div class="journey-stages" aria-label="旅行安排"><span>出发前 · 做好准备</span><span>旅行中 · 查看当天</span><span>回来后 · 留下回忆</span></div></section>`;
    const onTrip = t.phase === 'travelling', total = t.checklist_total || 0, done = t.checklist_done || 0;
    return `<section class="panel trip-focus journey-hero"><div class="journey-kicker">${onTrip ? '旅行中' : '待出发'}<span>仅管理员可见</span></div><div class="journey-hero-copy"><h2><a href="#trip/${t.id}">${esc(t.title)}</a></h2><p>${esc(t.destination)} · ${esc(t.start_date)} — ${esc(t.end_date)} · ${t.people} 人</p></div><div class="journey-next"><strong>${onTrip ? '今天是第 ' + t.today_day + ' 天' : '还有 ' + t.countdown + ' 天出发'}</strong><span>${t.plan_version ? '已采用第 ' + t.plan_version + ' 版计划' : '还没有采用计划'}</span></div><div class="journey-readiness"><label for="journey-ready">准备事项 <span>${done} / ${total} 完成</span></label><progress id="journey-ready" max="${Math.max(1, total)}" value="${done}"></progress></div><div class="actions"><a class="button primary" href="#trip/${t.id}/${onTrip ? 'today' : 'prepare'}">${icon(onTrip ? 'pin' : 'check')} ${onTrip ? '打开今日行程' : '继续出发准备'}</a><a class="button" href="#trip/${t.id}/plan">查看旅行计划 ${icon('arrow')}</a></div></section>`;
  }
  function dashboard(d) {
    const start = [['travel-agent', 'spark', '规划行程', '交给旅游助手，先选一份合适的方案'], ['record-new', 'pin', '留下一段足迹', '从几张照片、几句感受开始'], ['media', 'image', '整理旅行照片', '上传、选择或整理已有素材']];
    return heading('旅行工作台', '为自己和家人，把下一次出发安排得轻松一点。', '<a class="button" href="#trips">全部旅行 ' + icon('arrow') + '</a>') +
      `<div class="workspace-start">${currentTrip(d.trip)}<section class="panel workspace-actions"><div class="panel-top"><h2>常用操作</h2><span class="help">从一件小事开始</span></div>${start.map(([key, name, label, note]) => `<a class="workspace-action" href="#${key}"><span class="workspace-action-icon">${icon(name)}</span><span><strong>${label}</strong><small>${note}</small></span>${icon('arrow')}</a>`).join('')}<a class="workspace-action-foot" href="#guides">从已收藏的攻略安排出行 →</a></section></div>` +
      `<section class="workspace-library"><div class="workspace-section-heading"><h2>旅行资料</h2><p>灵感、计划和回忆，慢慢积累。</p></div><div class="stats-grid">${[['攻略', d.counts.total, 'guides', 'book', d.counts.private + ' 篇私密'], ['足迹', d.records.total, 'records', 'pin', d.records.public + ' 篇公开'], ['图片', d.media.count, 'media', 'image', bytes(d.media.bytes)], ['待整理', d.counts.draft, 'guides', 'tag', '草稿仅管理员可见']].map(([label, n, key, name, note]) => `<a class="stat-card" href="#${key}"><span class="stat-label">${icon(name)}${label}</span><strong>${n}</strong><small>${note}</small></a>`).join('')}</div></section>` +
      `<section class="panel workspace-recent"><div class="panel-top"><h2>最近整理的攻略</h2><a class="button small" href="#guides">查看全部 ${icon('arrow')}</a></div>${d.recent.map(g => `<a class="recent-row" href="#edit/${g.id}"><img data-admin-src="${esc(adminThumbnail(g.cover))}" loading="lazy" decoding="async" width="96" height="72" alt=""><div class="recent-copy"><strong>${esc(g.title)}</strong><span>${esc(g.destination)} · ${g.days} 天 · ${date(g.updated_at)}</span></div>${badge(g)}</a>`).join('') || `<div class="workspace-empty"><span>${icon('book')}</span><p>还没有攻略，先让助手规划一次想去的旅行。</p><a class="button small" href="#travel-agent">开始规划 →</a></div>`}</section>` +
      `<a class="workspace-storage" href="#data">${icon('data')}<span>${d.backup ? '最近备份：' + date(d.backup.created_at) : '暂未记录成功备份'}<small>查看数据与备份</small></span>${icon('arrow')}</a>`;
  }
  return {active, meta, navigation, dashboard, title: (route, fallback) => titles[viewOf(route)] || fallback};
})();
