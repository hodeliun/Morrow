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
    - id: included
      name: Included
      type: checkbox
    - id: included-quantity
      name: Included quantity
      type: formula
      formula: Inventory.Filter(CurrentValue.Included).Quantity.Sum()
    - id: demo-widget-price
      name: Widget price subtotal
      type: formula
      formula: Inventory.Filter(CurrentValue.Name = "Widget").Price.Sum()
    - id: demo-decimal-result
      name: DecimalResult
      type: formula
      formula: Quantity * Price * -61.728
      format:
        locale: de-DE
        precision: 1.5
        negativeFormat: parentheses
    - id: demo-decimal-raw
      name: DecimalRawCheck
      type: formula
      formula: If(DecimalResult > -1234.58, 42, 17)
    - id: demo-currency-result
      name: CurrencyResult
      type: formula
      formula: Quantity * Price * -61.7283
      format:
        currency: USD
        locale: en-US
        negativeFormat: parentheses
    - id: demo-currency-raw
      name: CurrencyRawCheck
      type: formula
      formula: If(CurrencyResult > -1234.568, 42, 17)
    - id: demo-progress-result
      name: ProgressResult
      type: formula
      formula: Quantity * Price * 2
      display: bar
      max: 75
    - id: demo-progress-raw
      name: ProgressRawCheck
      type: formula
      formula: If(ProgressResult > 50, 17, 42)
    - id: demo-percent-result
      name: Rate
      type: formula
      formula: Quantity / 8
      formulaResultType: percent
      format:
        locale: en-US
        precision: 1
    - id: demo-percent-raw
      name: RateRawCheck
      type: formula
      formula: Rate * 4
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
