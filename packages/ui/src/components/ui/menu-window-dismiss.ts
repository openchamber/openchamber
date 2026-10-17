import * as React from "react";
import { Menu } from "@base-ui/react/menu";

type MenuActions = NonNullable<NonNullable<React.ComponentProps<typeof Menu.Root>["actionsRef"]>["current"]>;

let openMenuCount = 0;

/**
 * Closes an open menu when the window loses focus, and lets clicks on the
 * desktop title bar reach the page while it is open.
 *
 * Base UI's menus never close on window blur, so a menu stayed open after the
 * user switched to another application. The title bar's native drag region
 * swallows pointer input before the page sees it, so a click there could not
 * dismiss the menu either; `oc-menu-open` turns the drag region off the same
 * way `oc-dialog-open` does for dialogs.
 */
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
