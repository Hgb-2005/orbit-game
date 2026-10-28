/** 持有型按钮只跟踪首个触点；取消、失焦和重置都释放，避免手机技能卡住。 */
export function bindHoldButton(button, onChange, host = window) {
  let pointer = null, keyboard = false;
  const notify = () => onChange(pointer !== null || keyboard);
  const release = () => {
    const captured = pointer;
    pointer = null; keyboard = false; notify();
    if (captured !== null && button.hasPointerCapture(captured)) button.releasePointerCapture(captured);
  };
  button.addEventListener("pointerdown", event => {
    if (event.button !== 0 || pointer !== null || button.disabled) return;
    event.preventDefault(); pointer = event.pointerId;
    button.setPointerCapture(pointer); notify();
  });
  for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) {
    button.addEventListener(type, event => { if (pointer === event.pointerId) release(); });
  }
  button.addEventListener("keydown", event => {
    if (![" ", "Enter"].includes(event.key) || button.disabled) return;
    event.preventDefault(); keyboard = true; notify();
  });
  button.addEventListener("keyup", event => {
    if ([" ", "Enter"].includes(event.key)) { event.preventDefault(); keyboard = false; notify(); }
  });
  button.addEventListener("blur", release);
  host.addEventListener("blur", release);
  return release;
}
