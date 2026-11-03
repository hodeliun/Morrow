import { createContext } from 'react';
import type { PageId, PageMeta, ViewDef } from '../../../core/model';

export type ViewChange = (change: (view: ViewDef) => ViewDef) => void;

export interface LinkedViewSourceOptions {
  sourceId: PageId | null;
  source: PageMeta | null;
  candidates: PageMeta[];
  editable: boolean;
  onSelectSource: (sourceId: PageId) => void;
  onOpenSource: () => void;
}

export const ViewChangeContext = createContext<ViewChange | null>(null);
