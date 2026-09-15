# Risk

Risk uses checked integer arithmetic. Each market has initial and maintenance
margin, leverage, position and open-interest limits. Available collateral is
distinct from reserved order margin. Funding and fees are separate ledger
changes. Liquidation is rejected for healthy accounts and uses the configured
maintenance threshold, with bankruptcy routed to insurance accounting.
