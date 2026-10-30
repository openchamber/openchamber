/**
 * Swallows the click a lifting finger may still fire after a long press
 * opened something. Over the pressed control that click would act on it;
 * over the sheet that just slid up under the finger it would pick a row or
 * close the sheet. Only that click goes: it comes right after this gesture's
 * pointerup, and the next press starts a gesture of its own.
 */
export const swallowGestureClick = (): void => {
  let timer = 0;
  const disarm = () => {
    window.clearTimeout(timer);
    window.removeEventListener('click', swallow, true);
    window.removeEventListener('pointerdown', disarm, true);
    window.removeEventListener('pointerup', release, true);
  };
  const swallow = (click: MouseEvent) => {
    click.preventDefault();
    click.stopPropagation();
    disarm();
  };
  const release = () => {
    timer = window.setTimeout(disarm, 400);
  };
  window.addEventListener('click', swallow, true);
  window.addEventListener('pointerdown', disarm, true);
  window.addEventListener('pointerup', release, true);
};
