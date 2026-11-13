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
  readonly insertViewCommand: string;
  readonly insertViewSlashTitle: string;
  readonly insertViewSlashDescription: string;
  readonly insertViewKeywords: string;
  readonly pickerTitle: string;
  readonly pickerSourceLabel: string;
  readonly pickerChooseSource: string;
  readonly pickerNoSources: string;
  readonly pickerInsert: string;
  readonly pickerRecapture: string;
  readonly pickerCancel: string;
  readonly pickerTargetCaptured: string;
  readonly pickerTargetUnavailable: string;
  readonly pickerSourceMissing: string;
  readonly pickerSourceUnsupported: string;
  readonly pickerSourceReadonly: string;
  readonly pickerApiUnsupported: string;
  readonly pickerDocumentChanged: string;
  readonly pickerSelectionChanged: string;
  readonly pickerTargetChanged: string;
  readonly pickerSessionChanged: string;
  readonly pickerSessionClosed: string;
  readonly pickerOwnerEnded: string;
  readonly pickerReadOnly: string;
  readonly pickerInsertRejected: string;
  readonly pickerAlreadyUsed: string;
  readonly pickerInsertFailed: string;
  readonly defaultViewSuffix: string;
  readonly unnamedDatabase: string;
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
    insertViewCommand: 'Polaris Dados: inserir visualização vinculada',
    insertViewSlashTitle: 'Inserir visualização do Polaris Dados',
    insertViewSlashDescription: 'Escolha um banco Polaris Dados e insira uma visualização vinculada.',
    insertViewKeywords: 'polaris dados tabela banco visualização vinculada',
    pickerTitle: 'Inserir visualização vinculada',
    pickerSourceLabel: 'Banco de origem',
    pickerChooseSource: 'Selecione um banco do Polaris Dados.',
    pickerNoSources: 'Nenhum banco legível e editável do Polaris Dados está disponível.',
    pickerInsert: 'Inserir visualização',
    pickerRecapture: 'Recapturar ponto na nota',
    pickerCancel: 'Cancelar',
    pickerTargetCaptured: 'Ponto de inserção capturado. Escolha um banco e insira quando estiver pronto.',
    pickerTargetUnavailable: 'Não há um editor de nota elegível. Abra a nota desejada e recapture o ponto.',
    pickerSourceMissing: 'O banco selecionado não está mais disponível. Escolha outro banco.',
    pickerSourceUnsupported: 'O banco selecionado não é compatível com o Polaris Dados neste momento.',
    pickerSourceReadonly: 'O banco está somente leitura ou há um conflito de salvamento. Resolva isso e tente novamente.',
    pickerApiUnsupported: 'Esta versão da API do Morrow não pode inserir visualizações do Polaris Dados.',
    pickerDocumentChanged: 'A nota mudou depois da captura. Revise o destino e recapture o ponto.',
    pickerSelectionChanged: 'A seleção mudou depois da captura. Recapture o ponto de inserção.',
    pickerTargetChanged: 'O destino mudou depois da captura. Recapture o ponto na nota desejada.',
    pickerSessionChanged: 'A sessão da nota mudou. Abra a nota desejada e recapture o ponto.',
    pickerSessionClosed: 'A sessão da nota foi encerrada. Abra outra nota e recapture o ponto.',
    pickerOwnerEnded: 'O plugin foi encerrado. Reative-o para inserir uma visualização.',
    pickerReadOnly: 'Morrow está em modo somente leitura. Não é possível inserir agora.',
    pickerInsertRejected: 'O editor recusou a inserção. O texto e o histórico da nota foram preservados.',
    pickerAlreadyUsed: 'Este ponto de inserção já foi usado. Recapture antes de tentar novamente.',
    pickerInsertFailed: 'Não foi possível inserir a visualização. O ponto foi liberado; recapture para tentar novamente.',
    defaultViewSuffix: 'visualização',
    unnamedDatabase: 'Banco de dados',
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
    insertViewCommand: 'Polaris Data: insert linked view',
    insertViewSlashTitle: 'Insert Polaris Data view',
    insertViewSlashDescription: 'Choose a Polaris Data database and insert a linked view.',
    insertViewKeywords: 'polaris data table database linked view',
    pickerTitle: 'Insert linked view',
    pickerSourceLabel: 'Source database',
    pickerChooseSource: 'Choose a Polaris Data database.',
    pickerNoSources: 'No readable and editable Polaris Data database is available.',
    pickerInsert: 'Insert view',
    pickerRecapture: 'Recapture note target',
    pickerCancel: 'Cancel',
    pickerTargetCaptured: 'Insertion target captured. Choose a database and insert when ready.',
    pickerTargetUnavailable: 'No eligible note editor is available. Open the target note and recapture.',
    pickerSourceMissing: 'The selected database is no longer available. Choose another database.',
    pickerSourceUnsupported: 'The selected database is not supported by Polaris Data right now.',
    pickerSourceReadonly: 'The database is read only or a save conflict is active. Resolve it and try again.',
    pickerApiUnsupported: 'This Morrow API version cannot insert Polaris Data views.',
    pickerDocumentChanged: 'The note changed after capture. Review the target and recapture.',
    pickerSelectionChanged: 'The selection changed after capture. Recapture the insertion target.',
    pickerTargetChanged: 'The target changed after capture. Recapture the target note.',
    pickerSessionChanged: 'The note session changed. Open the target note and recapture.',
    pickerSessionClosed: 'The note session ended. Open another note and recapture.',
    pickerOwnerEnded: 'The plugin ended. Enable it again to insert a view.',
    pickerReadOnly: 'Morrow is read only. A view cannot be inserted now.',
    pickerInsertRejected: 'The editor refused the insertion. Note text and history were preserved.',
    pickerAlreadyUsed: 'This insertion target was already used. Recapture before trying again.',
    pickerInsertFailed: 'The view could not be inserted. The target was released; recapture to retry.',
    defaultViewSuffix: 'view',
    unnamedDatabase: 'Database',
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
    insertViewCommand: 'Polaris Datos: insertar vista vinculada',
    insertViewSlashTitle: 'Insertar vista de Polaris Datos',
    insertViewSlashDescription: 'Elige una base de Polaris Datos e inserta una vista vinculada.',
    insertViewKeywords: 'polaris datos tabla base vista vinculada',
    pickerTitle: 'Insertar vista vinculada',
    pickerSourceLabel: 'Base de origen',
    pickerChooseSource: 'Elige una base de Polaris Datos.',
    pickerNoSources: 'No hay ninguna base de Polaris Datos legible y editable disponible.',
    pickerInsert: 'Insertar vista',
    pickerRecapture: 'Volver a capturar el punto en la nota',
    pickerCancel: 'Cancelar',
    pickerTargetCaptured: 'Punto de inserción capturado. Elige una base e inserta cuando quieras.',
    pickerTargetUnavailable: 'No hay un editor de nota elegible. Abre la nota deseada y vuelve a capturar.',
    pickerSourceMissing: 'La base seleccionada ya no está disponible. Elige otra base.',
    pickerSourceUnsupported: 'Polaris Datos no admite la base seleccionada en este momento.',
    pickerSourceReadonly: 'La base es de solo lectura o hay un conflicto de guardado. Resuélvelo e inténtalo de nuevo.',
    pickerApiUnsupported: 'Esta versión de la API de Morrow no puede insertar vistas de Polaris Datos.',
    pickerDocumentChanged: 'La nota cambió después de la captura. Revisa el destino y vuelve a capturarlo.',
    pickerSelectionChanged: 'La selección cambió después de la captura. Vuelve a capturar el destino.',
    pickerTargetChanged: 'El destino cambió después de la captura. Vuelve a capturar la nota deseada.',
    pickerSessionChanged: 'La sesión de la nota cambió. Abre la nota deseada y vuelve a capturar.',
    pickerSessionClosed: 'La sesión de la nota terminó. Abre otra nota y vuelve a capturar.',
    pickerOwnerEnded: 'El plugin terminó. Actívalo de nuevo para insertar una vista.',
    pickerReadOnly: 'Morrow está en modo de solo lectura. No se puede insertar ahora.',
    pickerInsertRejected: 'El editor rechazó la inserción. Se preservaron el texto y el historial de la nota.',
    pickerAlreadyUsed: 'Este punto de inserción ya se usó. Vuelve a capturarlo antes de intentarlo otra vez.',
    pickerInsertFailed: 'No se pudo insertar la vista. Se liberó el destino; vuelve a capturarlo para reintentar.',
    defaultViewSuffix: 'vista',
    unnamedDatabase: 'Base de datos',
  },
};

export function providerMessages(locale: SupportedLocale): ProviderMessages {
  return MESSAGES[locale];
}
