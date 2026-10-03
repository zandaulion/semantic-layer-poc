# Warehouse rules

These are business rules for this synthetic warehouse. They are injected into
the agent's instructions. They name concepts, not tables, so they hold whatever
the physical names are.

- A client is a customer.
- The customer dimension keeps history: one row per version of a customer.
  Count customers by their business identifier, not by surrogate key, and use
  the current version unless the question is about a past date.
- Daily balance and position facts are snapshots. To get a balance at a month
  end, read the latest snapshot date in that month. Do not sum the days.
- Default means the loan delinquency default flag is set. This is a provisional
  POC definition; say so as an assumption.
- "Transactions" with no qualifier means account transactions. Do not use
  payment or ATM facts unless the question mentions them.
- If no period is given, use all available rows and state that as an
  assumption.
- If a month is named without a year, do not guess the year. Ask which year.
- Amounts may be held in several currencies. If a total mixes currencies,
  prefer a base or reporting amount column when the table has one, and state
  the choice as an assumption.
- Never invent a metric definition, a date role or a join that the table
  definitions do not support.
