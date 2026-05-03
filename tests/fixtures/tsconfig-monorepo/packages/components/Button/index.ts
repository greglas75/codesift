// Directory-as-module: the alias `@components/Button` should resolve to this
// index.ts, NOT the directory itself. This pins the empty-string + isFile() gate.
export const Button = () => "<button/>";
