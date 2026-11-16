import * as React from "react";
import { Menu } from "@base-ui/react/menu";

type MenuActions = NonNullable<NonNullable<React.ComponentProps<typeof Menu.Root>["actionsRef"]>["current"]>;

let openMenuCount = 0;

export function useMenuWindowDismiss(open: boolean): React.RefObject<MenuActions | null> {
  const actionsRef = React.useRef<MenuActions | null>(null);

  React.useEffect(() => {
    if (!open) return;
    openMenuCount += 1;
    document.documentElement.classList.add("oc-menu-open");
    const onBlur = () => actionsRef.current?.close();
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("blur", onBlur);
      openMenuCount = Math.max(0, openMenuCount - 1);
      if (openMenuCount === 0) {
        document.documentElement.classList.remove("oc-menu-open");
      }
    };
  }, [open]);

  return actionsRef;
}
