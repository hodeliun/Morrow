import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';

const demoFolder = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const demoRoot = resolve(demoFolder, 'vault');
if (!demoFolder.endsWith('demo')) {
  throw new Error(`Refusing to write outside the expected demo folder: ${demoFolder}`);
}

const ids = {
  home: 'demo-home',
  asha: 'asha-profile',
  mystic: 'asha-mystic',
  relicsPage: 'asha-relics-page',
  atelier: 'asha-workshop',
  artifacts: 'artifact-table',
  ring: 'artifact-glass-ring',
  lantern: 'artifact-mist-lantern',
  resources: 'resource-table',
  mana: 'resource-mana',
  entertainment: 'entertainment-table',
  skyGarden: 'media-sky-garden',
  windAtlas: 'media-wind-atlas',
  northStation: 'media-north-station',
  financePanel: 'finance-panel',
  banks: 'bank-table',
  bankAurora: 'bank-aurora',
  categories: 'category-table',
  booksCategory: 'category-books',
  leisureCategory: 'category-leisure',
  invoices: 'invoice-table',
  invoiceDecember: 'invoice-december-2026',
  invoiceJanuary: 'invoice-january-2027',
  expenses: 'expense-table',
  bookExpense: 'expense-book',
  ticketExpense: 'expense-ticket',
  renewalExpense: 'expense-renewal',
  planner: 'installment-table',
  purchase: 'installment-purchase',
};

const option = (id, name, color) => ({ id, name, color });
const property = (id, name, type, extra = {}) => ({ id, name, type, options: [], ...extra });
const view = (id, name, type, extra = {}) => ({
  id,
  name,
  type,
  filters: [],
  sorts: [],
  groupBy: null,
  dateProp: null,
  hidden: [],
  ...extra,
});
const attachment = (id, name) =>
  JSON.stringify({
    format: 'morrow-property-attachments',
    version: 1,
    files: [{ id, name, type: 'image/svg+xml', size: 512, createdAt: 1793016000000 }],
  });
const richCanvas = JSON.stringify({
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Registro do lote: ', marks: [{ type: 'bold' }] },
        { type: 'text', text: 'peça de estudo criada para a demonstração.' },
      ],
    },
    {
      type: 'bulletList',
      content: [
        { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'material: vidro fosco' }] }] },
        { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'origem: Oficina de Asha' }] }] },
      ],
    },
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Ficha local: ', marks: [{ type: 'link', attrs: { href: 'https://demo.invalid/atlas' } }] },
        { type: 'image', attrs: { fileId: 'attachments/constellation.svg', alt: 'Mapa de constelações demonstrativo' } },
      ],
    },
  ],
});

const artifactsDb = {
  properties: [
    property('artifact-cost', 'Custo base', 'number', { description: 'Custo fictício em unidades de energia.' }),
    property('artifact-active', 'Ativo', 'checkbox', { fillMode: 'default', defaultValue: true }),
    property('artifact-image', 'Referência visual', 'image', { media: { multiple: true } }),
    property('artifact-notes', 'Caderno de campo', 'richCanvas'),
    property('artifact-resources', 'Recursos', 'relation', {
      relation: {
        targetDatabaseId: ids.resources,
        multiple: true,
        isInverse: true,
        displayPropertyId: null,
        inversePropertyId: 'resource-artifact',
        filters: [],
      },
    }),
  ],
  views: [
    view('artifact-all', 'Todos os artefatos', 'table', {
      sorts: [{ prop: 'title', dir: 'asc' }],
      widths: { title: 240, 'artifact-cost': 110, 'artifact-active': 90 },
      summaries: { 'artifact-cost': 'sum' },
    }),
  ],
};

const resourcesDb = {
  properties: [
    property('resource-artifact', 'Artefato', 'relation', {
      relation: {
        targetDatabaseId: ids.artifacts,
        multiple: false,
        isInverse: false,
        displayPropertyId: null,
        inversePropertyId: 'artifact-resources',
        filters: [{ id: 'active-artifact-only', prop: 'artifact-active', op: 'checked', value: true }],
      },
    }),
    property('resource-projected-cost', 'Custo projetado', 'number', {
      fillMode: 'calculated',
      formula: 'ThisRow.Artefato.`Custo base`',
    }),
    property('resource-kind', 'Tipo de recurso', 'select', {
      options: [option('mana-option', 'Mana', 'purple'), option('focus-option', 'Foco', 'blue')],
      fillMode: 'default',
      defaultValue: 'mana-option',
    }),
  ],
  views: [view('resource-all', 'Recursos', 'table')],
};

const statusOptions = [
  option('planned-option', 'Planejado', 'gray'),
  option('in-progress-option', 'Em andamento', 'blue'),
  option('complete-option', 'Concluído', 'green'),
];
const mediaOptions = [
  option('anime-option', 'Anime', 'purple'),
  option('book-option', 'Livro', 'brown'),
  option('series-option', 'Série', 'orange'),
];
const entertainmentDb = {
  properties: [
    property('media-type', 'Tipo', 'select', { options: mediaOptions }),
    property('media-status', 'Status', 'select', {
      options: statusOptions,
      fillMode: 'default',
      defaultValue: 'planned-option',
    }),
    property('media-completed', 'Unidades concluídas', 'number', { format: { precision: 0 } }),
    property('media-total', 'Unidades totais', 'number', { format: { precision: 0 } }),
    property('media-rating', 'Avaliação', 'scale', {
      format: { min: 1, max: 5, step: 1, scaleIcon: 'star' },
    }),
    property('media-progress', 'Progresso', 'percent', {
      fillMode: 'calculated',
      formula: 'ThisRow.`Unidades concluídas` / ThisRow.`Unidades totais`',
      format: { locale: 'pt-BR', precision: 0 },
      display: 'bar',
      max: 1,
    }),
    property('media-favorite', 'Favorito', 'checkbox', { fillMode: 'default', defaultValue: false }),
    property('media-art', 'Arte', 'image', { media: { multiple: true } }),
  ],
  views: [
    view('media-gallery', 'Galeria por status', 'gallery', {
      groupBy: 'media-status',
      cardProperties: ['media-type', 'media-progress', 'media-rating'],
      cardImageProp: 'media-art',
      summaries: { 'media-progress': 'average', 'media-rating': 'average' },
    }),
    view('media-board', 'Quadro por status', 'board', {
      groupBy: 'media-status',
      sorts: [{ prop: 'media-type', dir: 'asc' }],
    }),
    view('media-anime', 'Anime · busca de exemplo', 'table', {
      filters: [{ id: 'anime-type-filter', prop: 'media-type', op: 'is', value: 'anime-option' }],
      search: 'Jardim',
      hidden: ['media-favorite', 'media-art'],
      widths: { title: 240, 'media-status': 150, 'media-progress': 120 },
      wrap: ['title'],
      summaries: { 'media-progress': 'average', 'media-rating': 'average' },
    }),
    view('media-list', 'Lista', 'list'),
  ],
};

const financeCurrency = { locale: 'pt-BR', currency: 'BRL', precision: 2 };
const financeControls = [
  { id: 'year-control', name: 'Ano', type: 'number', value: 2026, defaultValue: 2026, options: [], format: { min: 2020, max: 2100, step: 1 } },
  { id: 'month-control', name: 'Mês', type: 'number', value: 12, defaultValue: 1, options: [], format: { min: 1, max: 12, step: 1 } },
];
const tokenBinding = (source, token, occurrence = 0) => {
  let start = -1;
  let from = 0;
  for (let index = 0; index <= occurrence; index += 1) {
    start = source.indexOf(token, from);
    if (start < 0) throw new Error(`Missing formula token ${token}: ${source}`);
    from = start + token.length;
  }
  return { start, end: start + token.length, source: token };
};
const propertyBinding = (source, token, databaseId, propertyId, occurrence = 0) => ({
  ...tokenBinding(source, token, occurrence),
  kind: 'property',
  databaseId,
  propertyId,
});
const controlBinding = (source, token, controlId) => ({
  ...tokenBinding(source, token),
  pageId: ids.financePanel,
  kind: 'control',
  controlId,
});
const databaseBinding = (source, token, databaseId) => ({
  ...tokenBinding(source, token),
  kind: 'database',
  databaseId,
});
const sortedBindings = (bindings) => bindings.sort((a, b) => a.start - b.start || a.end - b.end);
const expenseMonthFormula = 'Year(ThisRow.Data) = Ano and Month(ThisRow.Data) = Mês';
const expenseMonthFormulaBindings = (source) => sortedBindings([
  propertyBinding(source, 'Data', ids.expenses, 'expense-date', 0),
  controlBinding(source, 'Ano', 'year-control'),
  propertyBinding(source, 'Data', ids.expenses, 'expense-date', 1),
  controlBinding(source, 'Mês', 'month-control'),
]);
const annualFormula = '`Despesas de demonstração`.Filter(Year(CurrentValue.Data) = Ano).Valor.Sum()';
const monthlyFormula = '`Despesas de demonstração`.Filter(Year(CurrentValue.Data) = Ano and Month(CurrentValue.Data) = Mês).Valor.Sum()';
const pendingFormula = '`Despesas de demonstração`.Filter(Year(CurrentValue.Data) = Ano and Month(CurrentValue.Data) = Mês and CurrentValue.`Pago?` = false).Valor.Sum()';
const annualFormulaBindings = sortedBindings([
  databaseBinding(annualFormula, '`Despesas de demonstração`', ids.expenses),
  propertyBinding(annualFormula, 'Data', ids.expenses, 'expense-date'),
  controlBinding(annualFormula, 'Ano', 'year-control'),
  propertyBinding(annualFormula, 'Valor', ids.expenses, 'expense-amount'),
]);
const monthlyFormulaBindings = sortedBindings([
  databaseBinding(monthlyFormula, '`Despesas de demonstração`', ids.expenses),
  propertyBinding(monthlyFormula, 'Data', ids.expenses, 'expense-date', 0),
  controlBinding(monthlyFormula, 'Ano', 'year-control'),
  propertyBinding(monthlyFormula, 'Data', ids.expenses, 'expense-date', 1),
  controlBinding(monthlyFormula, 'Mês', 'month-control'),
  propertyBinding(monthlyFormula, 'Valor', ids.expenses, 'expense-amount'),
]);
const pendingFormulaBindings = sortedBindings([
  databaseBinding(pendingFormula, '`Despesas de demonstração`', ids.expenses),
  propertyBinding(pendingFormula, 'Data', ids.expenses, 'expense-date', 0),
  controlBinding(pendingFormula, 'Ano', 'year-control'),
  propertyBinding(pendingFormula, 'Data', ids.expenses, 'expense-date', 1),
  controlBinding(pendingFormula, 'Mês', 'month-control'),
  propertyBinding(pendingFormula, '`Pago?`', ids.expenses, 'expense-paid'),
  propertyBinding(pendingFormula, 'Valor', ids.expenses, 'expense-amount'),
]);
const banksDb = {
  properties: [property('bank-name', 'Nome', 'text')],
  views: [view('bank-all', 'Bancos', 'table')],
};
const categoriesDb = {
  properties: [property('category-name', 'Nome', 'text')],
  views: [view('category-all', 'Categorias', 'table')],
};
const invoicesDb = {
  properties: [
    property('invoice-date', 'Data', 'date', { format: { locale: 'pt-BR', dateStyle: 'long' } }),
    property('invoice-bank', 'Banco', 'relation', {
      relation: {
        targetDatabaseId: ids.banks,
        multiple: false,
        isInverse: false,
        displayPropertyId: 'bank-name',
        inversePropertyId: null,
        filters: [],
      },
    }),
    property('invoice-expenses', 'Despesas', 'relation', {
      relation: {
        targetDatabaseId: ids.expenses,
        multiple: true,
        isInverse: true,
        displayPropertyId: null,
        inversePropertyId: 'expense-invoice',
        filters: [],
      },
    }),
    property('invoice-total', 'Total da fatura', 'currency', {
      fillMode: 'calculated',
      formula: 'ThisRow.Despesas.Valor.Sum()',
      format: financeCurrency,
    }),
  ],
  views: [
    view('invoice-all', 'Faturas', 'table', { summaries: { 'invoice-total': 'sum' } }),
  ],
};

const expensesDb = {
  properties: [
    property('expense-date', 'Data', 'date', { format: { locale: 'pt-BR', dateStyle: 'medium' } }),
    property('expense-amount', 'Valor', 'currency', { format: financeCurrency }),
    property('expense-paid', 'Pago?', 'checkbox', { fillMode: 'default', defaultValue: false }),
    property('expense-invoice', 'Fatura', 'relation', {
      relation: {
        targetDatabaseId: ids.invoices,
        multiple: false,
        isInverse: false,
        displayPropertyId: null,
        inversePropertyId: 'invoice-expenses',
        filters: [],
      },
    }),
    property('expense-category', 'Categoria', 'relation', {
      relation: {
        targetDatabaseId: ids.categories,
        multiple: false,
        isInverse: false,
        displayPropertyId: 'category-name',
        inversePropertyId: null,
        filters: [],
      },
    }),
    property('expense-bank-label', 'Banco projetado', 'formula', {
      formula: 'ThisRow.Fatura.Banco.Nome',
    }),
    property('expense-receipt', 'Comprovante', 'image', { media: { multiple: true } }),
    property('expense-notes', 'Registro rico', 'richCanvas'),
  ],
  views: [
    view('expense-all', 'Todas as despesas', 'table', {
      widths: { title: 250, 'expense-date': 130, 'expense-amount': 120, 'expense-paid': 90 },
      summaries: { 'expense-amount': 'sum' },
    }),
    view('expense-controlled-month', 'Ano e mês selecionados', 'table', {
      filters: [
        {
          id: 'expense-year-month-filter',
          prop: '$formula',
          op: 'is',
          value: null,
          formula: expenseMonthFormula,
          formulaBindings: expenseMonthFormulaBindings(expenseMonthFormula),
        },
      ],
      summaries: { 'expense-amount': 'sum' },
    }),
    view('expense-pending', 'Pendentes', 'table', {
      filters: [{ id: 'expense-unpaid-filter', prop: 'expense-paid', op: 'unchecked', value: false }],
      summaries: { 'expense-amount': 'sum' },
    }),
  ],
};

const installmentAction = {
  label: 'Simular parcelas',
  icon: 'play',
  color: 'blue',
  steps: [
    {
      id: 'create-three-installments',
      type: 'addRows',
      count: { source: 'prop("Parcelas")', bindings: [] },
      title: { source: 'concat("Parcela ", CurrentValue)', bindings: [] },
      values: {
        'installment-date': {
          source: 'DateAdd(prop("Data inicial"), CurrentValue - 1, "months")',
          bindings: [],
        },
        'installment-amount': {
          source:
            'Floor(prop("Total da compra") * 100 / prop("Parcelas")) / 100 + If(CurrentValue <= Mod(prop("Total da compra") * 100, prop("Parcelas")), 0.01, 0)',
          bindings: [],
        },
      },
    },
  ],
};
const installmentsDb = {
  properties: [
    property('installment-start-date', 'Data inicial', 'date', { format: { locale: 'pt-BR' } }),
    property('installment-total', 'Total da compra', 'currency', { format: financeCurrency }),
    property('installment-count', 'Parcelas', 'number', { format: { precision: 0 } }),
    property('installment-date', 'Data da parcela', 'date', { format: { locale: 'pt-BR' } }),
    property('installment-amount', 'Valor', 'currency', { format: financeCurrency }),
    property('installment-button', 'Simular parcelas', 'button', { action: installmentAction }),
  ],
  views: [view('installment-all', 'Compra e parcelas', 'table', { summaries: { 'installment-amount': 'sum' } })],
};

const artifactActiveView = view('linked-artifacts-active', 'Artefatos ativos', 'table', {
  filters: [{ id: 'linked-active-filter', prop: 'artifact-active', op: 'checked', value: true }],
  widths: { title: 250, 'artifact-cost': 115, 'artifact-active': 90 },
  summaries: { 'artifact-cost': 'sum' },
});
const artifactAllView = view('linked-artifacts-all', 'Todos os artefatos · oficina', 'table', {
  sorts: [{ prop: 'title', dir: 'asc' }],
  summaries: { 'artifact-cost': 'sum' },
});
const linkedView = (sourceDatabaseId, blockId, config) =>
  `<!-- morrow:linked-view:v1:${encodeURIComponent(JSON.stringify({ sourceDatabaseId, blockId, view: config }))} -->\n\n**Visualização vinculada:** abra no Morrow para editar as linhas compartilhadas.`;
const controlMarker = (id, label) => `<span data-morrow-control="${id}">${label}</span>`;
const resultMarker = (attrs) =>
  `<span data-morrow-result="${encodeURIComponent(JSON.stringify(attrs)).replaceAll("'", '%27')}">${attrs.name}</span>`;
const columns = (...items) =>
  `<div data-columns>\n${items.map((item) => `<div data-column>\n\n${item}\n\n</div>`).join('\n')}\n</div>`;
const filterFormula = (id, formula) => ({
  id,
  prop: '$formula',
  op: 'is',
  value: null,
  formula,
  formulaBindings: [],
});
const monthlyExpenseView = view('linked-expenses-month', 'Despesas do ano e mês', 'table', {
  filters: [{
    ...filterFormula('linked-expenses-date-filter', expenseMonthFormula),
    formulaBindings: expenseMonthFormulaBindings(expenseMonthFormula),
  }],
  widths: { title: 250, 'expense-date': 130, 'expense-amount': 120 },
  summaries: { 'expense-amount': 'sum' },
});
const brlFormat = { locale: 'pt-BR', currency: 'BRL', precision: 2 };

const pageDefinitions = [
  {
    path: 'Comece aqui.md',
    id: ids.home,
    order: 0,
    favorite: true,
    metadata: { title: 'Comece aqui — demonstração', icon: '🧭' },
    body: `# Um cofre de demonstração\n\nEste cofre contém somente personagens, títulos, compras e imagens inventados. Use os links para explorar cada fluxo e os exemplos editáveis.\n\n## Percursos\n\n- [[Asha — demonstração]] — perfil de RPG, colunas editáveis, páginas filhas e uma view de artefatos ativos.\n- [[Ateliê de Asha]] — segunda view independente da mesma tabela de artefatos.\n- [[Artefatos de demonstração]] — fonte única dos artefatos e do custo projetado em recursos.\n- [[Entretenimento de demonstração]] — status, tipo, avaliação, progresso, galeria, quadro e tabela filtrada.\n- [[Painel financeiro]] — controles de ano e mês, totais em reais, faturas, despesas e relações.\n- [[Planejador de parcelas]] — botão de prévia para dividir R$ 100,00 em três parcelas entre 2026 e 2027.\n\nConsulte README.md ao lado da pasta vault para instruções de abertura e proveniência dos assets. Para começar, abra “Asha — demonstração” ou “Painel financeiro”.`,
  },
  {
    path: 'Asha — demonstração.md',
    id: ids.asha,
    order: 2,
    metadata: {
      title: 'Asha — demonstração',
      icon: 'morrow-icon:file:attachments%2Fasha-symbol.svg|#9D573D',
      cover: 'attachments/asha-cover.svg',
      morrowCoverPosition: 42,
    },
    body: `${columns(
      '![](attachments/asha-portrait.svg)\n\n*Retrato geométrico fictício de Asha.*',
      '### Características\n\n| Traço | Valor |\n| --- | --- |\n| Arquétipo | Tecelã do crepúsculo |\n| Origem | Vale das lanternas |\n| Vigor | 7 |\n| Foco | 12 |',
      '### Navegação\n\n- [[Místico]]\n- [[Artefatos]]\n- [[Ateliê de Asha]]\n- [[Recursos de demonstração]]',
    )}\n\n<!-- morrow:block-background:purple -->\n## Informações\n\nAsha estuda artefatos que guardam lembranças de lugares imaginários. Este bloco tem fundo arredondado configurado pelo Morrow.\n\n## Artefatos ativos\n\n${linkedView(ids.artifacts, 'asha-artifacts-active-block', artifactActiveView)}\n\n### Instruções de exploração\n\nAltere o custo do Anel de Vidro nesta view ou na página-fonte. Em [[Recursos de demonstração]], o custo projetado acompanha a mudança sem selecionar a relação novamente.`,
  },
  {
    path: 'Asha — demonstração/Místico.md',
    id: ids.mystic,
    order: 0,
    metadata: { title: 'Místico', icon: '✨' },
    body: `# Místico\n\nA disciplina fictícia de Asha combina observação das estrelas e pequenas lanternas de vidro.\n\n- Símbolo: uma espiral sobre um círculo.\n- Prática: registrar mudanças de luz ao longo de três noites.\n- Limite: nenhuma fórmula ou dado externo é consultado.`,
  },
  {
    path: 'Asha — demonstração/Artefatos.md',
    id: ids.relicsPage,
    order: 1,
    metadata: { title: 'Artefatos', icon: '🪄' },
    body: `# Artefatos\n\nA tabela de origem fica em [[Artefatos de demonstração]]. Suas linhas são compartilhadas pelas duas visualizações embutidas; cada bloco guarda o próprio filtro e ordenação.\n\nO Anel de Vidro começa com custo base 3. Edite-o para 4 e confira o reflexo em [[Recursos de demonstração]].`,
  },
  {
    path: 'Ateliê de Asha.md',
    id: ids.atelier,
    order: 3,
    metadata: { title: 'Ateliê de Asha', icon: '🧰' },
    body: `# Ateliê de Asha\n\nEsta segunda visualização usa a mesma tabela, mas começa sem filtro. Remover este bloco não remove nenhum artefato.\n\n${linkedView(ids.artifacts, 'atelier-artifacts-all-block', artifactAllView)}\n\nVolte para [[Asha — demonstração]] e compare as configurações.`,
  },
  {
    path: 'Artefatos de demonstração.md',
    id: ids.artifacts,
    order: 4,
    metadata: { title: 'Artefatos de demonstração', icon: '🧿', kind: 'database', database: artifactsDb },
    body: `# Artefatos de demonstração\n\nEsta é a fonte dos registros vistos em Asha e no ateliê. A relação “Recursos” é o inverso da coluna “Artefato”.`,
  },
  {
    path: 'Artefatos de demonstração/Anel de Vidro.md',
    id: ids.ring,
    order: 0,
    metadata: {
      title: 'Anel de Vidro',
      icon: '🔮',
      cover: 'attachments/constellation.svg',
      'Custo base': 3,
      Ativo: true,
      'Referência visual': attachment('attachments/constellation.svg', 'constellation.svg'),
      'Caderno de campo': richCanvas,
    },
    body: `# Anel de Vidro\n\nUma peça inventada que ajuda a armazenar uma pequena carga de mana.`,
  },
  {
    path: 'Artefatos de demonstração/Lanterna de Névoa.md',
    id: ids.lantern,
    order: 1,
    metadata: {
      title: 'Lanterna de Névoa',
      icon: '🏮',
      cover: 'attachments/constellation.svg',
      'Custo base': 5,
      Ativo: false,
      'Referência visual': attachment('attachments/constellation.svg', 'constellation.svg'),
    },
    body: `# Lanterna de Névoa\n\nUma peça fictícia ainda inativa; não aparece no filtro de artefatos ativos nem nas opções da relação de recursos.`,
  },
  {
    path: 'Recursos de demonstração.md',
    id: ids.resources,
    order: 5,
    metadata: { title: 'Recursos de demonstração', icon: '💠', kind: 'database', database: resourcesDb },
    body: `# Recursos de demonstração\n\nA coluna calculada “Custo projetado” lê o custo do artefato relacionado. O seletor de “Artefato” está limitado à tabela-fonte e aos artefatos ativos.`,
  },
  {
    path: 'Recursos de demonstração/Mana de Asha.md',
    id: ids.mana,
    order: 0,
    metadata: { title: 'Mana de Asha', icon: '🔹', Artefato: 'Anel de Vidro', 'Tipo de recurso': 'Mana' },
    body: `# Mana de Asha\n\nA relação aponta para o Anel de Vidro. Edite o custo na fonte: o resultado calculado deve passar de 3 para 4 sem alterar esta relação.`,
  },
  {
    path: 'Entretenimento de demonstração.md',
    id: ids.entertainment,
    order: 6,
    metadata: { title: 'Entretenimento de demonstração', icon: '🎬', kind: 'database', database: entertainmentDb },
    body: `# Entretenimento de demonstração\n\nUse as abas **Galeria por status**, **Quadro por status** e **Anime · busca de exemplo**. A busca é “Jardim”; limpe-a no painel de filtros para conferir o tipo e explorar as demais linhas.\n\nO progresso é calculado: 3/12 = 25%, 0/20 = 0% e 8/8 = 100%. Avaliação vazia continua diferente de zero. “Status” aparece na ordem Planejado, Em andamento, Concluído.`,
  },
  {
    path: 'Entretenimento de demonstração/Jardim das Nuvens.md',
    id: ids.skyGarden,
    order: 0,
    metadata: {
      title: 'Jardim das Nuvens',
      icon: '☁️',
      cover: 'attachments/constellation.svg',
      Tipo: 'Anime',
      Status: 'Em andamento',
      'Unidades concluídas': 3,
      'Unidades totais': 12,
      Avaliação: 4,
      'Arte': attachment('attachments/constellation.svg', 'constellation.svg'),
    },
    body: `# Jardim das Nuvens\n\nAnime fictício.`,
  },
  {
    path: 'Entretenimento de demonstração/Atlas dos Ventos.md',
    id: ids.windAtlas,
    order: 1,
    metadata: {
      title: 'Atlas dos Ventos',
      icon: '📚',
      cover: 'attachments/constellation.svg',
      Tipo: 'Livro',
      Status: 'Planejado',
      'Unidades concluídas': 0,
      'Unidades totais': 20,
      'Arte': attachment('attachments/constellation.svg', 'constellation.svg'),
    },
    body: `# Atlas dos Ventos\n\nLivro fictício com avaliação ainda não informada.`,
  },
  {
    path: 'Entretenimento de demonstração/Estação do Norte.md',
    id: ids.northStation,
    order: 2,
    metadata: {
      title: 'Estação do Norte',
      icon: '🚉',
      cover: 'attachments/constellation.svg',
      Tipo: 'Série',
      Status: 'Concluído',
      'Unidades concluídas': 8,
      'Unidades totais': 8,
      Avaliação: 5,
      'Arte': attachment('attachments/constellation.svg', 'constellation.svg'),
    },
    body: `# Estação do Norte\n\nSérie fictícia concluída.`,
  },
  {
    path: 'Painel financeiro.md',
    id: ids.financePanel,
    order: 7,
    metadata: { title: 'Painel financeiro', icon: '🧾', morrowControls: financeControls },
    body: `# Painel financeiro\n\n**Ano:** ${controlMarker('year-control', 'Ano')} &nbsp; **Mês:** ${controlMarker('month-control', 'Mês')}\n\n**Total do mês:** ${resultMarker({ resultId: 'monthly-total', pageId: ids.financePanel, name: 'Total do mês', formula: monthlyFormula, bindings: monthlyFormulaBindings, outputType: 'currency', format: brlFormat })}  \n**Pendente:** ${resultMarker({ resultId: 'pending-total', pageId: ids.financePanel, name: 'Total pendente', formula: pendingFormula, bindings: pendingFormulaBindings, outputType: 'currency', format: brlFormat })}  \n**Total de 2026:** ${resultMarker({ resultId: 'annual-total', pageId: ids.financePanel, name: 'Total anual', formula: annualFormula, bindings: annualFormulaBindings, outputType: 'currency', format: brlFormat })}\n\nCom Ano 2026 e Mês 12, a view mostra duas despesas, total de R$ 100,00 e pendente de R$ 60,00. Troque os controles para 2027 e 1: deve restar uma despesa de R$ 25,00 sem editar datas.\n\n## Despesas filtradas\n\n${linkedView(ids.expenses, 'finance-expenses-month-block', monthlyExpenseView)}\n\nAs páginas [[Faturas de demonstração]], [[Bancos de demonstração]] e [[Categorias de demonstração]] mostram as relações e a soma calculada por fatura.`,
  },
  {
    path: 'Bancos de demonstração.md',
    id: ids.banks,
    order: 8,
    metadata: { title: 'Bancos de demonstração', icon: '🏦', kind: 'database', database: banksDb },
    body: `# Bancos de demonstração\n\nBanco inventado para o cenário local.`,
  },
  {
    path: 'Bancos de demonstração/Banco Aurora.md',
    id: ids.bankAurora,
    order: 0,
    metadata: { title: 'Banco Aurora', 'Nome': 'Banco Aurora' },
    body: `# Banco Aurora\n\nInstituição fictícia, sem ligação com qualquer banco real.`,
  },
  {
    path: 'Categorias de demonstração.md',
    id: ids.categories,
    order: 9,
    metadata: { title: 'Categorias de demonstração', icon: '🗂️', kind: 'database', database: categoriesDb },
    body: `# Categorias de demonstração\n\nCategorias sintéticas usadas nas despesas.`,
  },
  {
    path: 'Categorias de demonstração/Livros.md',
    id: ids.booksCategory,
    order: 0,
    metadata: { title: 'Livros', Nome: 'Livros' },
    body: `# Livros\n\nCategoria fictícia.`,
  },
  {
    path: 'Categorias de demonstração/Lazer.md',
    id: ids.leisureCategory,
    order: 1,
    metadata: { title: 'Lazer', Nome: 'Lazer' },
    body: `# Lazer\n\nCategoria fictícia.`,
  },
  {
    path: 'Faturas de demonstração.md',
    id: ids.invoices,
    order: 10,
    metadata: { title: 'Faturas de demonstração', icon: '📅', kind: 'database', database: invoicesDb },
    body: `# Faturas de demonstração\n\nO campo “Total da fatura” soma as despesas relacionadas; Banco é uma relação com a tabela de bancos.`,
  },
  {
    path: 'Faturas de demonstração/Fatura Dezembro 2026.md',
    id: ids.invoiceDecember,
    order: 0,
    metadata: { title: 'Fatura Dezembro 2026', Data: '2026-12-01', Banco: 'Banco Aurora' },
    body: `# Fatura Dezembro 2026\n\nFatura sintética de dezembro.`,
  },
  {
    path: 'Faturas de demonstração/Fatura Janeiro 2027.md',
    id: ids.invoiceJanuary,
    order: 1,
    metadata: { title: 'Fatura Janeiro 2027', Data: '2027-01-01', Banco: 'Banco Aurora' },
    body: `# Fatura Janeiro 2027\n\nFatura sintética de janeiro.`,
  },
  {
    path: 'Despesas de demonstração.md',
    id: ids.expenses,
    order: 11,
    metadata: { title: 'Despesas de demonstração', icon: '💳', kind: 'database', database: expensesDb },
    body: `# Despesas de demonstração\n\nDados inventados. A view “Ano e mês selecionados” usa os controles do [[Painel financeiro]].`,
  },
  {
    path: 'Despesas de demonstração/Livro demonstrativo.md',
    id: ids.bookExpense,
    order: 0,
    metadata: {
      title: 'Livro demonstrativo',
      Data: '2026-12-05',
      Valor: 60,
      'Pago?': false,
      Fatura: 'Fatura Dezembro 2026',
      Categoria: 'Livros',
      Comprovante: attachment('attachments/aurora-receipt.svg', 'aurora-receipt.svg'),
      'Registro rico': richCanvas,
    },
    body: `# Livro demonstrativo\n\nCompra fictícia de R$ 60,00.`,
  },
  {
    path: 'Despesas de demonstração/Ingresso demonstrativo.md',
    id: ids.ticketExpense,
    order: 1,
    metadata: {
      title: 'Ingresso demonstrativo',
      Data: '2026-12-15',
      Valor: 40,
      'Pago?': true,
      Fatura: 'Fatura Dezembro 2026',
      Categoria: 'Lazer',
      Comprovante: attachment('attachments/aurora-receipt.svg', 'aurora-receipt.svg'),
      'Registro rico': richCanvas,
    },
    body: `# Ingresso demonstrativo\n\nCompra fictícia já paga de R$ 40,00.`,
  },
  {
    path: 'Despesas de demonstração/Renovação demonstrativa.md',
    id: ids.renewalExpense,
    order: 2,
    metadata: {
      title: 'Renovação demonstrativa',
      Data: '2027-01-05',
      Valor: 25,
      'Pago?': false,
      Fatura: 'Fatura Janeiro 2027',
      Categoria: 'Livros',
      Comprovante: attachment('attachments/aurora-receipt.svg', 'aurora-receipt.svg'),
    },
    body: `# Renovação demonstrativa\n\nCompra fictícia de R$ 25,00.`,
  },
  {
    path: 'Planejador de parcelas.md',
    id: ids.planner,
    order: 12,
    metadata: { title: 'Planejador de parcelas', icon: '🧮', kind: 'database', database: installmentsDb },
    body: `# Planejador de parcelas\n\nNa linha “Compra demonstrativa”, use **Simular parcelas** e confira a prévia. A ação calcula três datas mensais começando em 05/12/2026 e distribui R$ 100,00 em R$ 33,34 + R$ 33,33 + R$ 33,33. Execute uma vez para criar as linhas de teste; a tabela é separada do total mensal do painel.`,
  },
  {
    path: 'Planejador de parcelas/Compra demonstrativa.md',
    id: ids.purchase,
    order: 0,
    metadata: {
      title: 'Compra demonstrativa',
      'Data inicial': '2026-12-05',
      'Total da compra': 100,
      Parcelas: 3,
    },
    body: `# Compra demonstrativa\n\nCompra sintética de R$ 100,00.`,
  },
];

const svgAssets = {
  'attachments/asha-cover.svg': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 420" width="1200" height="420"><defs><linearGradient id="sky" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#241c3b"/><stop offset=".55" stop-color="#80556f"/><stop offset="1" stop-color="#e2a36f"/></linearGradient></defs><rect width="1200" height="420" fill="url(#sky)"/><circle cx="895" cy="112" r="54" fill="#f7d9a3" opacity=".9"/><path d="M0 340 205 198l150 123 180-185 176 173 173-138 316 172v77H0Z" fill="#392f53"/><path d="m0 372 226-122 184 128 205-142 185 121 190-95 210 103v55H0Z" fill="#273649"/><g fill="#fff0cf" opacity=".8"><circle cx="150" cy="92" r="3"/><circle cx="288" cy="143" r="2"/><circle cx="478" cy="67" r="3"/><circle cx="690" cy="104" r="2"/><circle cx="1030" cy="72" r="3"/></g></svg>`,
  'attachments/asha-portrait.svg': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 300" width="240" height="300"><rect width="240" height="300" rx="24" fill="#eee4d8"/><circle cx="120" cy="93" r="48" fill="#d79b72"/><path d="M70 93c0-50 99-67 104 1-22-8-34-25-40-43-15 22-35 37-64 42Z" fill="#46344f"/><path d="M37 278c8-82 43-121 83-121s77 39 83 121Z" fill="#6d7189"/><path d="M79 184 120 226l42-42-9 94H89Z" fill="#b65e61"/><path d="M95 76c7-4 14-4 21 0M132 76c7-4 14-4 21 0" fill="none" stroke="#513842" stroke-width="4" stroke-linecap="round"/><path d="M104 112c10 8 21 8 32 0" fill="none" stroke="#8c4d4a" stroke-width="4" stroke-linecap="round"/><circle cx="183" cy="210" r="12" fill="#f1cc75"/></svg>`,
  'attachments/asha-symbol.svg': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128" fill="currentColor"><circle cx="64" cy="64" r="48" fill="none" stroke="currentColor" stroke-width="8"/><path d="M65 20c28 13 37 40 19 62-13 16-38 21-50 6-10-13-3-30 13-36 12-4 24 1 26 12 2 9-7 16-15 12" fill="none" stroke="currentColor" stroke-width="8" stroke-linecap="round"/><path d="m64 2 7 14-7 14-7-14Z"/></svg>`,
  'attachments/constellation.svg': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360" width="640" height="360"><rect width="640" height="360" rx="24" fill="#272641"/><circle cx="318" cy="175" r="112" fill="#423b66"/><path d="m185 205 81-77 70 54 88-92" fill="none" stroke="#f4d487" stroke-width="5"/><g fill="#fff1bd"><circle cx="185" cy="205" r="9"/><circle cx="266" cy="128" r="9"/><circle cx="336" cy="182" r="9"/><circle cx="424" cy="90" r="9"/></g><circle cx="488" cy="236" r="38" fill="#d27a78" opacity=".85"/><path d="M103 279c72-56 136-43 184-11s102 36 164-8 110-31 145-4" fill="none" stroke="#7889a8" stroke-width="9" stroke-linecap="round"/></svg>`,
  'attachments/aurora-receipt.svg': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 300" width="480" height="300"><rect width="480" height="300" rx="20" fill="#edf0e6"/><rect x="72" y="35" width="336" height="230" rx="14" fill="#fffdf7" stroke="#7e907d" stroke-width="4"/><circle cx="112" cy="79" r="17" fill="#88a188"/><path d="M151 70h190M151 87h135M100 128h278M100 157h233M100 186h278M100 215h175" stroke="#abb6a3" stroke-width="8" stroke-linecap="round"/><text x="240" y="51" text-anchor="middle" font-family="sans-serif" font-size="16" fill="#536452">RECIBO FICTÍCIO</text></svg>`,
};

const write = (relativePath, content) => {
  const target = resolve(demoRoot, relativePath);
  if (!target.startsWith(`${demoRoot}/`) && !target.startsWith(`${demoRoot}\\`))
  throw new Error(`Refusing to write outside demo/vault/: ${target}`);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, 'utf8');
};

for (const [path, svg] of Object.entries(svgAssets)) write(path, `${svg}\n`);
for (const page of pageDefinitions) {
  const yaml = stringify(page.metadata, { lineWidth: 0 }).trimEnd();
  const body = page.body.trim().replace(/[ \t]+\n/g, '\n\n');
  write(page.path, `---\n${yaml}\n---\n\n${body}\n`);
}

const created = Date.UTC(2026, 9, 26, 12);
const registry = {
  version: 1,
  pages: Object.fromEntries(
    pageDefinitions.map((page) => [
      page.path,
      {
        id: page.id,
        created,
        order: page.order,
        ...(page.favorite ? { favorite: true } : {}),
      },
    ]),
  ),
};
write('.morrow/workspace.json', `${JSON.stringify(registry, null, 2)}\n`);
write('.morrow/recent.json', `${JSON.stringify({ opened: { [ids.home]: created }, activity: {} }, null, 2)}\n`);

const readme = `# Morrow — cofre de demonstração\n\n## Abrir\n\n1. Inicie o Morrow.\n2. Escolha **Abrir uma pasta** e selecione demo/vault/ neste repositório.\n3. Abra a página favorita **Comece aqui — demonstração** na barra lateral.\n4. Siga os percursos. As páginas, tabelas e assets já estão no cofre; o gerador não é necessário para abrir.\n\nO script demo/.morrow-tools/build-demo.mjs recria o cofre com conteúdo determinístico quando executado da raiz do repositório: node demo/.morrow-tools/build-demo.mjs. A validação automatizada pode ser executada com npx vitest run demo/.morrow-tools/demo-vault.test.ts.\n\n## Proveniência e privacidade\n\nTodos os nomes, números, imagens, capas e símbolos são sintéticos. Os SVGs em demo/vault/attachments/ foram desenhados como formas geométricas locais para esta demonstração; não foram baixados de sites nem derivados de retratos, marcas ou vaults pessoais. Não há URLs de imagem, contas, dados bancários reais ou conexões externas. O link dentro da célula rica aponta para demo.invalid e serve somente como exemplo de texto vinculado.\n\nOs arquivos demo/vault/.morrow/workspace.json e recent.json dão IDs estáveis às páginas e destacam a página inicial. Não copie este cofre sobre um vault pessoal.\n`;
writeFileSync(
  resolve(demoFolder, 'README.md'),
  readme.replace(
    'npx vitest run demo/.morrow-tools/demo-vault.test.ts',
    'npx vitest run --config demo/.morrow-tools/vitest.config.mts',
  ),
  'utf8',
);

console.log(`Generated ${pageDefinitions.length} Markdown pages and ${Object.keys(svgAssets).length} local SVG assets in ${demoRoot}`);
