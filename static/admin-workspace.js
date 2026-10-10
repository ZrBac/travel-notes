/* Common navigation for the private travel space. Reuses existing routes and APIs. */
const AdminWorkspace = (() => {
  const groups = [
    {title: '常用功能', items: [['trips', 'compass', '我的旅行'], ['guides', 'book', '攻略管理'], ['records', 'pin', '旅行足迹'], ['media', 'image', '图片素材'], ['travel-agent', 'spark', '旅游助手']]},
    {title: '设置与维护', collapsible: true, items: [['agent', 'settings', '网站管家'], ['settings', 'sliders', '站点设置'], ['taxonomy', 'tag', '分类与标签'], ['data', 'data', '数据与备份'], ['audit', 'clock', '操作记录'], ['account', 'user', '管理员账号']]}
  ];
  const aliases = {dashboard: 'trips', trip: 'trips', 'trip-new': 'trips', edit: 'guides', new: 'guides', import: 'guides', trash: 'guides', 'record-edit': 'records', 'record-new': 'records', 'record-trash': 'records'};
  const titles = {dashboard: '我的旅行', guides: '攻略管理', trash: '攻略回收站', records: '旅行足迹', 'record-trash': '足迹回收站', media: '图片素材', taxonomy: '分类与标签', 'travel-agent': '旅游助手', agent: '网站管家', settings: '站点设置', data: '数据与备份', audit: '操作记录', account: '管理员账号', edit: '编辑攻略', new: '新建攻略', 'record-edit': '编辑旅行足迹', 'record-new': '记录旅行足迹'};
  const viewOf = route => route.split(/[/?]/)[0];
  const active = route => aliases[viewOf(route)] || viewOf(route);
  function meta(view) {
    const key = active(view), group = groups.find(g => g.items.some(item => item[0] === key));
    const label = group?.items.find(item => item[0] === key)?.[2] || '我的旅行';
    const child = {edit: '编辑攻略', new: '新建攻略', trash: '回收站', import: '导入攻略', 'record-edit': '编辑足迹', 'record-new': '新建足迹', 'record-trash': '回收站', 'trip-new': '安排出行', trip: '旅行详情'}[view];
    return {key, label, breadcrumb: child ? label + ' / ' + child : label};
  }
  function navigation(view) {
    const selected = active(view);
    const link = ([key, name, label]) => `<a class="nav-item ${selected === key ? 'active' : ''}" href="#${key}" ${selected === key ? 'aria-current="page"' : ''}>${icon(name)}<span>${label}</span></a>`;
    return groups.map(group => {
      const links = `<div class="nav-group-items">${group.items.map(link).join('')}</div>`;
      return group.collapsible
        ? `<details class="nav-group nav-system" ${group.items.some(item => item[0] === selected) ? 'open' : ''}><summary>${group.title}<span class="nav-chevron" aria-hidden="true"></span></summary>${links}</details>`
        : `<nav class="nav-group" aria-label="${group.title}">${links}</nav>`;
    }).join('');
  }
  return {active, meta, navigation, title: (route, fallback) => titles[viewOf(route)] || fallback};
})();

// Small action menus close after outside clicks or Escape, including on touch screens.
document.addEventListener('click', event => {
  for (const menu of document.querySelectorAll('.admin-more[open]')) if (!menu.contains(event.target)) menu.open = false;
});
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  for (const menu of document.querySelectorAll('.admin-more[open]')) { menu.open = false; menu.querySelector('summary').focus(); }
});
