/**
 * 链接协议白名单。
 *
 * 预览里点链接不能真的导航：视图一旦离开插件页面就回不来了。
 * 而且本插件没有申报 shell.openExternal 权限，也无法把链接交给系统打开，
 * 所以点击的语义是「把地址告诉用户」（走无权限要求的 ui.showToast）。
 * 危险协议（javascript: / data: / vbscript: 等）直接标为不支持。
 */

const SAFE = /^(?:https?:|mailto:)/i;
const UNSAFE_SCHEME = /^(?:javascript|data|vbscript|file|blob):/i;

export function isSafeLink(href: string): boolean {
  const trimmed = href.trim();
  if (!trimmed) return false;
  if (UNSAFE_SCHEME.test(trimmed)) return false;
  // 相对路径在 file:// 下没有意义，也不允许当作可点击链接。
  if (!/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return false;
  return SAFE.test(trimmed);
}
