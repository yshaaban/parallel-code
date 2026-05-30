declare const __APP_VERSION__: string;
declare const __APP_BUILD_STAMP__: string;
declare const __APP_BUILD_COMMIT__: string;
declare const __APP_BUILD_DIRTY__: boolean;

export const APP_VERSION = __APP_VERSION__;
export const APP_BUILD_STAMP = __APP_BUILD_STAMP__;
export const APP_BUILD_COMMIT = __APP_BUILD_COMMIT__;
export const APP_BUILD_DIRTY = __APP_BUILD_DIRTY__;

export function formatAppBuildLabel(): string {
  const dirtySuffix = APP_BUILD_DIRTY ? ' dirty' : '';
  return `${APP_VERSION} · ${APP_BUILD_COMMIT}${dirtySuffix} · ${APP_BUILD_STAMP}`;
}
