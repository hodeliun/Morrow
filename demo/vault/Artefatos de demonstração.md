---
title: Artefatos de demonstração
icon: 🧿
kind: database
database:
  properties:
    - id: artifact-cost
      name: Custo base
      type: number
      options: []
      description: Custo fictício em unidades de energia.
    - id: artifact-active
      name: Ativo
      type: checkbox
      options: []
      fillMode: default
      defaultValue: true
    - id: artifact-image
      name: Referência visual
      type: image
      options: []
      media:
        multiple: true
    - id: artifact-notes
      name: Caderno de campo
      type: richCanvas
      options: []
    - id: artifact-resources
      name: Recursos
      type: relation
      options: []
      relation:
        targetDatabaseId: resource-table
        multiple: true
        isInverse: true
        displayPropertyId: null
        inversePropertyId: resource-artifact
        filters: []
  views:
    - id: artifact-all
      name: Todos os artefatos
      type: table
      filters: []
      sorts:
        - prop: title
          dir: asc
      groupBy: null
      dateProp: null
      hidden: []
      widths:
        title: 240
        artifact-cost: 110
        artifact-active: 90
      summaries:
        artifact-cost: sum
---

# Artefatos de demonstração

Esta é a fonte dos registros vistos em Asha e no ateliê. A relação “Recursos” é o inverso da coluna “Artefato”.
