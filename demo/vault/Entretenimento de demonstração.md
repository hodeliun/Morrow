---
title: Entretenimento de demonstração
icon: 🎬
kind: database
database:
  properties:
    - id: media-type
      name: Tipo
      type: select
      options:
        - id: anime-option
          name: Anime
          color: purple
        - id: book-option
          name: Livro
          color: brown
        - id: series-option
          name: Série
          color: orange
    - id: media-status
      name: Status
      type: select
      options:
        - id: planned-option
          name: Planejado
          color: gray
        - id: in-progress-option
          name: Em andamento
          color: blue
        - id: complete-option
          name: Concluído
          color: green
      fillMode: default
      defaultValue: planned-option
    - id: media-completed
      name: Unidades concluídas
      type: number
      options: []
      format:
        precision: 0
    - id: media-total
      name: Unidades totais
      type: number
      options: []
      format:
        precision: 0
    - id: media-rating
      name: Avaliação
      type: scale
      options: []
      format:
        min: 1
        max: 5
        step: 1
        scaleIcon: star
    - id: media-progress
      name: Progresso
      type: percent
      options: []
      fillMode: calculated
      formula: ThisRow.`Unidades concluídas` / ThisRow.`Unidades totais`
      format:
        locale: pt-BR
        precision: 0
      display: bar
      max: 1
    - id: media-favorite
      name: Favorito
      type: checkbox
      options: []
      fillMode: default
      defaultValue: false
    - id: media-art
      name: Arte
      type: image
      options: []
      media:
        multiple: true
  views:
    - id: media-gallery
      name: Galeria por status
      type: gallery
      filters: []
      sorts: []
      groupBy: media-status
      dateProp: null
      hidden: []
      cardProperties:
        - media-type
        - media-progress
        - media-rating
      cardImageProp: media-art
      summaries:
        media-progress: average
        media-rating: average
    - id: media-board
      name: Quadro por status
      type: board
      filters: []
      sorts:
        - prop: media-type
          dir: asc
      groupBy: media-status
      dateProp: null
      hidden: []
    - id: media-anime
      name: Anime · busca de exemplo
      type: table
      filters:
        - id: anime-type-filter
          prop: media-type
          op: is
          value: anime-option
      sorts: []
      groupBy: null
      dateProp: null
      hidden:
        - media-favorite
        - media-art
      search: Jardim
      widths:
        title: 240
        media-status: 150
        media-progress: 120
      wrap:
        - title
      summaries:
        media-progress: average
        media-rating: average
    - id: media-list
      name: Lista
      type: list
      filters: []
      sorts: []
      groupBy: null
      dateProp: null
      hidden: []
---

# Entretenimento de demonstração

Use as abas **Galeria por status**, **Quadro por status** e **Anime · busca de exemplo**. A busca é “Jardim”; limpe-a no painel de filtros para conferir o tipo e explorar as demais linhas.

O progresso é calculado: 3/12 = 25%, 0/20 = 0% e 8/8 = 100%. Avaliação vazia continua diferente de zero. “Status” aparece na ordem Planejado, Em andamento, Concluído.
