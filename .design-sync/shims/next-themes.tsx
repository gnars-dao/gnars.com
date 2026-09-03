/* Stands in for `next-themes` in the Claude Design bundle. Only `Toaster`
 * (ui/sonner.tsx) reads it in the synced scope. The real hook needs a
 * ThemeProvider mounted by the app; previews render standalone, so this
 * reports a stable light theme instead of leaving it undefined.
 *
 * Aliased in via .design-sync/tsconfig.ds.json `compilerOptions.paths`. */
import * as React from "react";

export function useTheme() {
  return {
    theme: "light",
    setTheme: () => {},
    resolvedTheme: "light",
    systemTheme: "light" as const,
    themes: ["light", "dark"],
    forcedTheme: undefined,
  };
}

export function ThemeProvider({ children }: { children?: React.ReactNode }) {
  return <>{children}</>;
}
