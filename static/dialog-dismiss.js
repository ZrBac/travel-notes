// Shared by static and dynamically created dialogs, including the photo viewer.
(() => {
  let press = null;
  let released = false;
  function outside(dialog, event) {
    const rect = dialog.getBoundingClientRect();
    return event.clientX < rect.left || event.clientX > rect.right ||
      event.clientY < rect.top || event.clientY > rect.bottom;
  }
  document.addEventListener('pointerdown', event => {
    const dialog = event.target.closest('dialog[open]');
    released = false;
    press = event.isPrimary && event.button === 0 && dialog && outside(dialog, event)
      ? {dialog, id: event.pointerId, x: event.clientX, y: event.clientY} : null;
  }, true);
  document.addEventListener('pointerup', event => {
    released = !!press && press.id === event.pointerId &&
      outside(press.dialog, event) &&
      Math.hypot(event.clientX - press.x, event.clientY - press.y) < 10;
  }, true);
  document.addEventListener('pointercancel', () => { press = null; released = false; }, true);
  document.addEventListener('close', () => { press = null; released = false; }, true);
  document.addEventListener('click', event => {
    const dialog = press?.dialog;
    const dismiss = released && dialog?.open && event.target === dialog && outside(dialog, event);
    press = null;
    released = false;
    if (!dismiss) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    // Use the same cancellable event as Esc so confirmation promises resolve
    // as cancellation and existing cancellation guards remain effective.
    if (dialog.dispatchEvent(new Event('cancel', {cancelable: true})) && dialog.open) {
      dialog.close();
    }
  }, true);
})();
