---
title: Recursos de demonstração
icon: 💠
kind: database
database:
  properties:
    - id: resource-artifact
      name: Artefato
      type: relation
      options: []
      relation:
        targetDatabaseId: artifact-table
        multiple: false
        isInverse: false
        displayPropertyId: null
        inversePropertyId: artifact-resources
        filters:
          - id: active-artifact-only
            prop: artifact-active
            op: checked
            value: true
    - id: resource-projected-cost
      name: Custo projetado
      type: number
      options: []
      fillMode: calculated
      formula: ThisRow.Artefato.`Custo base`
    - id: resource-kind
      name: Tipo de recurso
      type: select
      options:
        - id: mana-option
          name: Mana
          color: purple
        - id: focus-option
          name: Foco
          color: blue
      fillMode: default
      defaultValue: mana-option
  views:
    - id: resource-all
      name: Recursos
      type: table
      filters: []
      sorts: []
      groupBy: null
      dateProp: null
      hidden: []
---

# Recursos de demonstração

A coluna calculada “Custo projetado” lê o custo do artefato relacionado. O seletor de “Artefato” está limitado à tabela-fonte e aos artefatos ativos.
