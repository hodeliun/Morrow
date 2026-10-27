import { createContext } from 'react';
import type { ViewDef } from '../../../core/model';

export type ViewChange = (change: (view: ViewDef) => ViewDef) => void;

export const ViewChangeContext = createContext<ViewChange | null>(null);
