import type { DatabaseProviderContext } from '../../../../src/app/plugins/providerApi';

export type SupportedLocale = DatabaseProviderContext['locale'];

export interface ProviderMessages {
  readonly region: string;
  readonly table: string;
  readonly editCell: (property: string, row: string) => string;
  readonly editorCell: (property: string, row: string) => string;
  readonly save: string;
  readonly cancel: string;
  readonly retry: string;
  readonly blank: string;
  readonly missing: string;
  readonly trueValue: string;
  readonly falseValue: string;
  readonly loading: string;
  readonly noDatabase: string;
  readonly readonly: string;
  readonly saving: string;
  readonly saved: string;
  readonly saveError: (detail: string) => string;
  readonly staleDraft: string;
  readonly invalidNumber: string;
  readonly details: string;
  readonly nothingToUndo: string;
  readonly nothingToRedo: string;
  readonly formulaError: string;
}

const MESSAGES: Record<SupportedLocale, ProviderMessages> = {
  pt: {
    region: 'Polaris Dados',
    table: 'Polaris Dados',
    editCell: (property, row) => `Editar ${property} de ${row}`,
    editorCell: (property, row) => `${property} de ${row}`,
    save: 'Salvar',
    cancel: 'Cancelar',
    retry: 'Tentar novamente',
    blank: 'Vazio',
    missing: 'Ausente',
    trueValue: 'Verdadeiro',
    falseValue: 'Falso',
    loading: 'Carregando dados…',
    noDatabase: 'Os dados deste banco não estão disponíveis.',
    readonly: 'Somente leitura.',
    saving: 'Salvando alterações…',
    saved: 'Alterações salvas.',
    saveError: () => 'Não foi possível salvar as alterações.',
    staleDraft: 'Os dados mudaram. Cancele e abra a célula novamente para editar a versão atual.',
    invalidNumber: 'Informe um número finito antes de salvar. Use Cancelar para descartar o rascunho.',
    details: 'Detalhes',
    nothingToUndo: 'Não há alteração para desfazer.',
    nothingToRedo: 'Não há alteração para refazer.',
    formulaError: 'Erro de fórmula',
  },
  en: {
    region: 'Polaris Data',
    table: 'Polaris Data',
    editCell: (property, row) => `Edit ${property} for ${row}`,
    editorCell: (property, row) => `${property} for ${row}`,
    save: 'Save',
    cancel: 'Cancel',
    retry: 'Retry',
    blank: 'Blank',
    missing: 'Missing',
    trueValue: 'True',
    falseValue: 'False',
    loading: 'Loading data…',
    noDatabase: 'This database data is unavailable.',
    readonly: 'Read only.',
    saving: 'Saving changes…',
    saved: 'Changes saved.',
    saveError: () => 'Could not save changes.',
    staleDraft: 'The data changed. Cancel and reopen the cell to edit the current version.',
    invalidNumber: 'Enter a finite number before saving. Use Cancel to discard the draft.',
    details: 'Details',
    nothingToUndo: 'There is no change to undo.',
    nothingToRedo: 'There is no change to redo.',
    formulaError: 'Formula error',
  },
  es: {
    region: 'Polaris Datos',
    table: 'Polaris Datos',
    editCell: (property, row) => `Editar ${property} para ${row}`,
    editorCell: (property, row) => `${property} para ${row}`,
    save: 'Guardar',
    cancel: 'Cancelar',
    retry: 'Reintentar',
    blank: 'Vacío',
    missing: 'Ausente',
    trueValue: 'Verdadero',
    falseValue: 'Falso',
    loading: 'Cargando datos…',
    noDatabase: 'Los datos de esta base no están disponibles.',
    readonly: 'Solo lectura.',
    saving: 'Guardando cambios…',
    saved: 'Cambios guardados.',
    saveError: () => 'No se pudieron guardar los cambios.',
    staleDraft: 'Los datos cambiaron. Cancela y vuelve a abrir la celda para editar la versión actual.',
    invalidNumber: 'Introduce un número finito antes de guardar. Usa Cancelar para descartar el borrador.',
    details: 'Detalles',
    nothingToUndo: 'No hay cambios para deshacer.',
    nothingToRedo: 'No hay cambios para rehacer.',
    formulaError: 'Error de fórmula',
  },
};

export function providerMessages(locale: SupportedLocale): ProviderMessages {
  return MESSAGES[locale];
}
