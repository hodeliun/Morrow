export interface ExternalOpenErrorActionInput {
  url: string | null;
  canChooseBrowser: boolean;
}

export interface ExternalOpenErrorAction {
  label: string;
  run(): void;
}

export function createChooseBrowserOnceAction(
  error: ExternalOpenErrorActionInput,
  label: string,
  chooseOnce: (url: string) => void,
): ExternalOpenErrorAction | undefined {
  const url = error.url;
  if (!url || !error.canChooseBrowser) return undefined;
  return { label, run: () => chooseOnce(url) };
}
