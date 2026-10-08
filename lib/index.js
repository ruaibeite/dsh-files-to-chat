/**
 * @ruaibeite/dsh-files-to-chat — 宿主半边（host half）。
 *
 * 纯 UI 插件：本插件的全部行为都在浏览器半边（`exports["./client"]`，经
 * package.json 的 `dsh.client` 声明被发现）。这里保留一个空的 `apply`，只为让插件
 * 在宿主 cordis.yml / Loader 里有一个身份——profile 的 bundle 栈需要一个可挂载的
 * 行，浏览器半边才会随之被投递。
 */

/** 宿主插件体——本插件没有宿主侧行为。 */
function apply() {}

export { apply };
