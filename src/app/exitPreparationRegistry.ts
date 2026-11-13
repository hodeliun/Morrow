import type { ExitPreparer, ExitPreparationSession } from './exitPreparation';

let registered: { readonly preparer: ExitPreparer } | null = null;

/** The desktop bridge can consume this leaf registry without importing the preparer's dependencies. */
export function registerExitPreparer(preparer: ExitPreparer): () => void {
  const registration = { preparer };
  registered = registration;
  return () => {
    if (registered === registration) registered = null;
  };
}

export function getExitPreparer(): ExitPreparer<ExitPreparationSession> | null {
  return registered?.preparer ?? null;
}
