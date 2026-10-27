---
title: Planejador de parcelas
icon: 🧮
kind: database
database:
  properties:
    - id: installment-start-date
      name: Data inicial
      type: date
      options: []
      format:
        locale: pt-BR
    - id: installment-total
      name: Total da compra
      type: currency
      options: []
      format: &a1
        locale: pt-BR
        currency: BRL
        precision: 2
    - id: installment-count
      name: Parcelas
      type: number
      options: []
      format:
        precision: 0
    - id: installment-date
      name: Data da parcela
      type: date
      options: []
      format:
        locale: pt-BR
    - id: installment-amount
      name: Valor
      type: currency
      options: []
      format: *a1
    - id: installment-button
      name: Simular parcelas
      type: button
      options: []
      action:
        label: Simular parcelas
        icon: play
        color: blue
        steps:
          - id: create-three-installments
            type: addRows
            count:
              source: prop("Parcelas")
              bindings: []
            title:
              source: concat("Parcela ", CurrentValue)
              bindings: []
            values:
              installment-date:
                source: DateAdd(prop("Data inicial"), CurrentValue - 1, "months")
                bindings: []
              installment-amount:
                source: Floor(prop("Total da compra") * 100 / prop("Parcelas")) / 100 + If(CurrentValue <= Mod(prop("Total da compra") * 100, prop("Parcelas")), 0.01, 0)
                bindings: []
  views:
    - id: installment-all
      name: Compra e parcelas
      type: table
      filters: []
      sorts: []
      groupBy: null
      dateProp: null
      hidden: []
      summaries:
        installment-amount: sum
---

# Planejador de parcelas

Na linha “Compra demonstrativa”, use **Simular parcelas** e confira a prévia. A ação calcula três datas mensais começando em 05/12/2026 e distribui R$ 100,00 em R$ 33,34 + R$ 33,33 + R$ 33,33. Execute uma vez para criar as linhas de teste; a tabela é separada do total mensal do painel.
