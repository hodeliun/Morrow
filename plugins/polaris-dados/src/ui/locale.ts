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
  readonly viewSettings: string;
  readonly undoView: string;
  readonly redoView: string;
  readonly removeUnavailableColumns: string;
  readonly viewTitleLabel: string;
  readonly rowTitleColumn: string;
  readonly columnPriority: string;
  readonly columnPriorityHint: string;
  readonly moveUp: string;
  readonly moveDown: string;
  readonly filterLabel: string;
  readonly filterNone: string;
  readonly filterPropertyLabel: string;
  readonly filterValueLabel: string;
  readonly unavailableProperty: string;
  readonly filterUnavailable: string;
  readonly unavailableColumnReferences: string;
  readonly viewNoUndo: string;
  readonly viewNoRedo: string;
  readonly viewNoChanges: string;
  readonly unsupportedViewApi: string;
  readonly viewHistoryError: (detail: string) => string;
  readonly viewDraftStale: string;
  readonly viewResolveDraft: string;
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
    viewSettings: 'Configurar visualização',
    undoView: 'Desfazer configuração',
    redoView: 'Refazer configuração',
    removeUnavailableColumns: 'Remover referências indisponíveis',
    viewTitleLabel: 'Título da visualização',
    rowTitleColumn: 'Título da linha',
    columnPriority: 'Prioridade das colunas',
    columnPriorityHint: 'As colunas não priorizadas continuam visíveis na ordem do banco.',
    moveUp: 'Mover acima',
    moveDown: 'Mover abaixo',
    filterLabel: 'Filtro numérico mínimo',
    filterNone: 'Sem filtro',
    filterPropertyLabel: 'Propriedade numérica',
    filterValueLabel: 'Limite mínimo',
    unavailableProperty: 'Coluna indisponível (preservada)',
    filterUnavailable:
      'O filtro aponta para uma coluna ausente ou não numérica. Todas as linhas continuam visíveis até reparar a referência.',
    unavailableColumnReferences:
      'Há referências de coluna indisponíveis. Elas serão preservadas até serem reparadas explicitamente.',
    viewNoUndo: 'Não há configuração para desfazer.',
    viewNoRedo: 'Não há configuração para refazer.',
    viewNoChanges: 'Sem alterações.',
    unsupportedViewApi: 'Esta visualização usa uma versão de API que o Polaris Dados não suporta.',
    viewHistoryError: () => 'Não foi possível atualizar o histórico desta visualização.',
    viewDraftStale: 'A configuração mudou. Cancele este rascunho e reabra a configuração atual.',
    viewResolveDraft: 'Conclua o rascunho aberto antes de desfazer ou refazer.',
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
    viewSettings: 'View settings',
    undoView: 'Undo view settings',
    redoView: 'Redo view settings',
    removeUnavailableColumns: 'Remove unavailable references',
    viewTitleLabel: 'View title',
    rowTitleColumn: 'Row title',
    columnPriority: 'Column priority',
    columnPriorityHint: 'Unprioritized columns remain visible in database order.',
    moveUp: 'Move up',
    moveDown: 'Move down',
    filterLabel: 'Minimum numeric filter',
    filterNone: 'No filter',
    filterPropertyLabel: 'Numeric property',
    filterValueLabel: 'Minimum value',
    unavailableProperty: 'Unavailable column (preserved)',
    filterUnavailable:
      'The filter references a missing or non-numeric column. All rows remain visible until the reference is repaired.',
    unavailableColumnReferences:
      'Some column references are unavailable. They will be preserved until explicitly repaired.',
    viewNoUndo: 'There is no view configuration to undo.',
    viewNoRedo: 'There is no view configuration to redo.',
    viewNoChanges: 'No changes.',
    unsupportedViewApi: 'This view uses an API version Polaris Data does not support.',
    viewHistoryError: () => 'Could not update this view’s history.',
    viewDraftStale: 'The configuration changed. Cancel this draft and reopen the current settings.',
    viewResolveDraft: 'Finish the open draft before undoing or redoing.',
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
    viewSettings: 'Configurar vista',
    undoView: 'Deshacer configuración',
    redoView: 'Rehacer configuración',
    removeUnavailableColumns: 'Eliminar referencias no disponibles',
    viewTitleLabel: 'Título de la vista',
    rowTitleColumn: 'Título de fila',
    columnPriority: 'Prioridad de columnas',
    columnPriorityHint: 'Las columnas sin prioridad siguen visibles en el orden de la base.',
    moveUp: 'Mover arriba',
    moveDown: 'Mover abajo',
    filterLabel: 'Filtro numérico mínimo',
    filterNone: 'Sin filtro',
    filterPropertyLabel: 'Propiedad numérica',
    filterValueLabel: 'Valor mínimo',
    unavailableProperty: 'Columna no disponible (conservada)',
    filterUnavailable:
      'El filtro apunta a una columna ausente o no numérica. Todas las filas seguirán visibles hasta reparar la referencia.',
    unavailableColumnReferences:
      'Hay referencias de columna no disponibles. Se conservarán hasta repararlas explícitamente.',
    viewNoUndo: 'No hay configuración de vista para deshacer.',
    viewNoRedo: 'No hay configuración de vista para rehacer.',
    viewNoChanges: 'Sin cambios.',
    unsupportedViewApi: 'Esta vista usa una versión de API que Polaris Datos no admite.',
    viewHistoryError: () => 'No se pudo actualizar el historial de esta vista.',
    viewDraftStale:
      'La configuración cambió. Cancela este borrador y vuelve a abrir la configuración actual.',
    viewResolveDraft: 'Termina el borrador abierto antes de deshacer o rehacer.',
  },
};

export function providerMessages(locale: SupportedLocale): ProviderMessages {
  return MESSAGES[locale];
}
