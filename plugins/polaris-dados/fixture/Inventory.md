---
kind: database
polarisDados:
  version: 1
  provider: polaris-dados
database:
  properties:
    - id: name
      name: Name
      type: text
    - id: quantity
      name: Quantity
      type: number
    - id: price
      name: Price
      type: number
    - id: total
      name: Total
      type: formula
      formula: Quantity * Price
    - id: inventory-quantity
      name: Inventory quantity
      type: formula
      formula: Inventory.Quantity.Sum()
  views:
    - id: inventory-table-v1
      name: Table
      type: table
      filters: []
      sorts: []
      groupBy: null
      dateProp: null
      hidden: []
---
# Inventory
