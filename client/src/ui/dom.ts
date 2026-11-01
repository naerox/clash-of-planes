// A typed `createElement` with properties and children. `tag` picks the element type
// (`el("input", …)` is an HTMLInputElement) and `props` is checked against that element's own
// properties, so `el("input", { maxLenght: 5 })` does not compile.

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}
