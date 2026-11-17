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
