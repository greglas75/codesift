import { analyzeDjangoSettings } from "../../django-settings.js";

export function runDjangoSettings(repo: string) {
  return analyzeDjangoSettings(repo);
}
