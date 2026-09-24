"""Generate a reproducible, synthetic banking DWH schema and metadata catalog.

This is a retrieval/SQL-generation stress fixture, not an approved banking model.
Run: python generate_banking_warehouse.py
"""

from __future__ import annotations

import csv
import json
from collections import Counter
from datetime import date, timedelta
from pathlib import Path


ROOT = Path(__file__).resolve().parent / "banking-poc"
SCHEMA = "bank_dwh"
TARGET_COLUMNS = 5_000

# Forty-two dimensions and fifty-eight facts. Each name is unique and stable.
DIMENSIONS = {
    "conformed": "date time customer household party account product branch channel currency organization employee",
    "deposits": "deposit_product deposit_term interest_rate_plan account_status account_relationship",
    "lending": "loan_product loan_purpose collateral_type credit_rating delinquency_band repayment_plan facility_type",
    "payments_cards": "payment_type payment_network merchant merchant_category card_product card_status terminal",
    "wealth": "security instrument_type portfolio market benchmark",
    "risk_compliance": "risk_model regulatory_report jurisdiction fraud_rule aml_scenario complaint_category",
}
FACTS = {
    "deposits": "account_balance_daily account_transaction deposit_balance_daily deposit_interest_accrual deposit_maturity overdraft_usage_daily account_fee account_hold",
    "lending": "loan_balance_daily loan_disbursement loan_repayment loan_interest_accrual loan_delinquency_daily loan_loss_provision collateral_valuation credit_limit_usage_daily loan_application",
    "payments": "payment_transaction payment_settlement payment_return wire_transfer direct_debit standing_order_execution atm_transaction card_authorization card_clearing",
    "cards": "card_balance_daily card_fee card_dispute card_chargeback card_reward_earning",
    "customer_service": "customer_interaction customer_campaign_response complaint service_case digital_session",
    "wealth": "security_position_daily security_trade security_price_daily portfolio_valuation_daily investment_fee corporate_action",
    "treasury_finance": "fx_trade fx_rate_daily liquidity_position_daily treasury_position_daily general_ledger_entry gl_balance_monthly cost_allocation",
    "risk_compliance": "credit_risk_exposure_daily market_risk_measure_daily operational_loss fraud_alert aml_alert kyc_review sanctions_screening regulatory_capital_daily stress_test_result",
}

# Curated subject vocabulary is shared where appropriate; the table stem supplies
# additional source-specific fields. All columns remain explicitly marked synthetic.
DIM_GROUPS = {
    "party": "customer household party employee",
    "account": "account account_status account_relationship",
    "product": "product deposit_product deposit_term interest_rate_plan loan_product loan_purpose repayment_plan facility_type payment_type payment_network card_product card_status instrument_type",
    "place": "branch channel organization terminal market jurisdiction",
    "merchant": "merchant merchant_category",
    "investment": "security portfolio benchmark",
    "risk": "collateral_type credit_rating delinquency_band risk_model regulatory_report fraud_rule aml_scenario complaint_category",
    "currency": "currency",
}
DIM_GROUP_FIELDS = {
    "party": "legal_name given_name family_name preferred_name birth_date incorporation_date national_id_hash tax_id_hash customer_segment_code customer_subsegment_code relationship_manager_id residence_country_code tax_residency_country_code city_name postal_code address_line_1 address_line_2 email_hash phone_hash occupation_code industry_code employer_name kyc_status_code kyc_review_date pep_status_code sanctions_status_code risk_band_code onboarding_date closure_date preferred_language_code preferred_contact_channel_code marketing_consent_flag privacy_consent_flag household_size_count annual_income_amount estimated_assets_amount source_of_wealth_code customer_since_date deceased_flag vulnerability_code",
    "account": "account_number_hash account_type_code account_subtype_code account_status_code status_reason_code opened_date closed_date dormant_since_date ownership_type_code signatory_count primary_holder_id servicing_branch_code product_code currency_code overdraft_limit_amount minimum_balance_amount available_limit_amount statement_frequency_code interest_plan_code fee_plan_code tax_treatment_code statement_delivery_code account_purpose_code freeze_status_code lien_status_code payment_restriction_code is_joint_account is_dormant is_blocked is_interest_bearing is_overdraft_enabled parent_account_id relationship_type_code relationship_start_date relationship_end_date mandate_type_code approval_date review_date",
    "product": "product_family_code product_category_code product_subcategory_code product_type_code offering_status_code launch_date retirement_date eligibility_code customer_segment_code minimum_amount maximum_amount minimum_term_months_count maximum_term_months_count standard_term_months_count base_currency_code rate_type_code standard_rate benchmark_code spread_rate repricing_frequency_code compounding_method_code payment_frequency_code settlement_cycle_code fee_schedule_code penalty_policy_code renewal_option_code early_termination_code tax_treatment_code regulatory_product_code accounting_product_code collateral_requirement_code risk_weight_code approval_date effective_date expiry_date is_secured is_revolving is_renewable is_promotional source_priority_code",
    "place": "country_code region_code city_name postal_code address_line_1 address_line_2 timezone_code jurisdiction_code legal_entity_code organization_unit_code parent_unit_code hierarchy_level business_line_code cost_center_code manager_id operating_status_code opening_date closure_date market_code market_type_code channel_type_code terminal_type_code service_area_code service_hours_code settlement_cutoff_time operating_currency_code regulatory_region_code reporting_region_code latitude_value longitude_value is_primary is_active_region is_customer_facing is_online location_risk_code location_size_code capacity_count network_code ownership_code",
    "merchant": "merchant_legal_name merchant_display_name merchant_category_code merchant_segment_code acquiring_bank_code settlement_account_id settlement_currency_code country_code city_name postal_code industry_code ownership_type_code onboarding_date activation_date closure_date merchant_risk_band_code chargeback_risk_band_code card_acceptance_code ecommerce_flag card_present_flag tokenization_flag terminal_count fee_plan_code interchange_category_code reserve_policy_code payout_frequency_code payout_delay_days_count compliance_status_code sanctions_status_code fraud_monitoring_code relationship_manager_id is_active is_cross_border merchant_group_code parent_merchant_id tax_id_hash address_line_1 address_line_2",
    "investment": "instrument_id isin_code ticker_symbol asset_class_code asset_subclass_code instrument_type_code issuer_id issuer_country_code trading_currency_code issue_date maturity_date coupon_rate yield_rate face_value_amount lot_size_count market_code exchange_code listing_status_code pricing_source_code valuation_method_code risk_class_code liquidity_class_code strategy_code investment_objective_code benchmark_code custody_account_id portfolio_manager_id inception_date closure_date portfolio_currency_code mandate_code risk_tolerance_code discretionary_flag distribution_policy_code settlement_cycle_code is_tradable is_derivative is_active_security parent_instrument_id regulatory_class_code",
    "risk": "rule_code rule_family_code rule_category_code scenario_code risk_type_code risk_subtype_code risk_band_code severity_code regulatory_basis_code reporting_framework_code report_frequency_code model_version_code scorecard_code threshold_amount threshold_rate minimum_score_value maximum_score_value review_frequency_code approval_status_code approval_date owner_unit_code model_owner_id rule_owner_id last_validation_date next_validation_date effective_date expiry_date is_reportable is_active_rule is_manual_review_required exception_policy_code remediation_code classification_code subclassification_code reason_code escalation_level_code evidence_requirement_code detection_window_days_count",
    "currency": "iso_alpha_code iso_numeric_code currency_name currency_symbol minor_unit_count country_code currency_type_code is_active is_settlement_currency is_reporting_currency valid_from_date valid_to_date rounding_rule_code rounding_precision_count central_bank_code currency_group_code exchange_market_code redenomination_date predecessor_currency_code successor_currency_code",
}

FACT_PACKS = {
    "rate": "base_currency_code quote_currency_code currency_pair_code market_code rate_type_code rate_source_code rate_fixing_code rate_date_key effective_date_key expiry_date_key bid_rate ask_rate mid_rate spot_rate forward_rate reference_rate official_rate opening_rate closing_rate high_rate low_rate average_rate previous_close_rate rate_change_amount rate_change_ratio quote_precision_count spread_rate forward_points_amount tenor_days_count fixing_time_code publication_at effective_at source_timestamp is_official is_estimated is_interpolated is_market_open rate_status_code validation_status_code",
    "balance": "opening_balance_amount closing_balance_amount available_balance_amount ledger_balance_amount average_balance_amount minimum_balance_amount maximum_balance_amount debit_turnover_amount credit_turnover_amount blocked_balance_amount hold_balance_amount overdraft_amount accrued_interest_amount accrued_fee_amount balance_change_amount prior_day_balance_amount reporting_balance_amount local_balance_amount base_balance_amount balance_currency_code exchange_rate days_in_period_count snapshot_timestamp reconciliation_status_code is_reconciled is_negative_balance is_over_limit balance_quality_code",
    "transaction": "transaction_id transaction_type_code transaction_subtype_code transaction_status_code transaction_reference_id external_reference_id posting_date_key value_date_key settlement_date_key debit_credit_code amount original_amount base_amount local_amount fee_amount tax_amount net_amount gross_amount exchange_rate counterparty_id counterparty_account_hash payment_reference channel_reference_id authorization_reference_id is_reversal is_adjustment is_cross_border is_cash transaction_count processing_status_code reconciliation_status_code initiated_at authorized_at posted_at settled_at",
    "loan": "loan_id facility_id loan_status_code principal_amount outstanding_principal_amount accrued_interest_amount interest_paid_amount principal_paid_amount scheduled_payment_amount actual_payment_amount overdue_amount writeoff_amount recovered_amount provision_amount exposure_at_default_amount collateral_value_amount loan_to_value_rate interest_rate margin_rate days_past_due delinquency_stage_code impairment_stage_code forbearance_flag default_flag origination_date_key maturity_date_key due_date_key payment_date_key repayment_sequence_number installment_number credit_limit_amount utilized_amount available_limit_amount restructure_flag loss_event_code",
    "payment": "payment_id payment_reference payment_method_code payment_rail_code payment_status_code originator_id beneficiary_id originator_account_hash beneficiary_account_hash initiated_at authorized_at clearing_at settled_at value_date_key settlement_date_key amount original_amount settlement_amount fee_amount interchange_amount exchange_rate original_currency_code settlement_currency_code payment_purpose_code remittance_reference clearing_reference_id network_reference_id return_reason_code rejection_reason_code is_returned is_cross_border is_high_priority processing_duration_seconds_count",
    "card": "card_token_hash card_product_code card_network_code merchant_id merchant_category_code merchant_country_code terminal_id authorization_id authorization_code clearing_id transaction_id transaction_amount billing_amount settlement_amount fee_amount interchange_amount reward_amount exchange_rate original_currency_code billing_currency_code card_present_flag ecommerce_flag tokenized_flag contactless_flag authorization_result_code decline_reason_code dispute_reason_code chargeback_stage_code fraud_score_value posted_at settled_at reversal_flag",
    "service": "interaction_id case_id campaign_id complaint_id digital_session_id interaction_type_code contact_reason_code contact_channel_code case_status_code case_priority_code resolution_code root_cause_code escalation_level_code service_level_code response_code contact_started_at contact_ended_at resolution_at handling_duration_seconds_count waiting_duration_seconds_count satisfaction_score_value sentiment_score_value message_count customer_effort_score_value agent_id queue_code is_escalated is_resolved is_repeat_contact is_regulatory_complaint product_interest_code followup_due_date_key",
    "wealth": "instrument_id portfolio_id trade_id position_id market_id quantity units_count unit_price_amount trade_price_amount market_price_amount market_value_amount book_value_amount cost_basis_amount realized_gain_amount unrealized_gain_amount dividend_amount coupon_amount accrued_income_amount fee_amount tax_amount net_asset_value_amount notional_amount trade_date_key settlement_date_key price_date_key exchange_rate market_currency_code custody_account_id trade_side_code execution_venue_code valuation_method_code pricing_source_code is_estimated_price is_corporate_action_adjusted",
    "treasury": "trade_id position_id counterparty_id trading_book_code legal_entity_code general_ledger_account_code cost_center_code transaction_currency_code reporting_currency_code notional_amount market_value_amount book_value_amount pnl_amount realized_pnl_amount unrealized_pnl_amount cash_flow_amount funding_amount reserve_amount liquidity_buffer_amount exchange_rate reference_rate margin_rate effective_date_key maturity_date_key settlement_date_key accounting_period_code posting_status_code hedge_designation_code liquidity_bucket_code maturity_bucket_code accounting_standard_code is_intercompany is_hedged is_reconciled",
    "risk": "risk_event_id exposure_id alert_id case_id model_id model_version_code risk_type_code risk_stage_code alert_severity_code investigation_status_code decision_code decision_reason_code score_value probability_of_default_rate loss_given_default_rate exposure_at_default_amount expected_loss_amount unexpected_loss_amount provision_amount risk_weighted_asset_amount capital_requirement_amount collateral_value_amount recovered_amount operational_loss_amount fraud_loss_amount stress_loss_amount breach_amount threshold_amount rule_id scenario_id report_id detection_at review_at closure_at is_reportable is_confirmed is_false_positive",
}

FACT_COMMON = "event_id event_type_code event_subtype_code event_status_code lifecycle_status_code source_event_id source_file_id batch_sequence_number correlation_id calculation_version_code reporting_basis_code is_adjusted is_exception is_reportable created_at completed_at".split()

DIMENSION_KEYS = {
    "deposits": "date customer account product branch channel currency deposit_product deposit_term account_status",
    "lending": "date customer account loan_product loan_purpose collateral_type credit_rating currency branch",
    "payments": "date customer account payment_type payment_network merchant channel currency branch",
    "cards": "date customer account card_product card_status merchant merchant_category channel currency",
    "customer_service": "date customer channel branch employee product complaint_category",
    "wealth": "date customer account portfolio security instrument_type market currency benchmark",
    "treasury_finance": "date organization branch currency product market",
    "risk_compliance": "date customer account organization jurisdiction risk_model currency branch",
}

DATE_FIELDS = """
date_key calendar_date day_of_week_number day_of_week_name day_of_month_number
day_of_year_number week_of_year_number iso_week_number month_number month_name
month_short_name quarter_number quarter_name calendar_year_number
calendar_year_month_code fiscal_year_number fiscal_quarter_number
fiscal_month_number fiscal_week_number is_weekend is_business_day
is_month_end is_quarter_end is_year_end is_public_holiday holiday_name
prior_business_date_key next_business_date_key prior_date_key next_date_key
month_start_date quarter_start_date
""".split()
TIME_FIELDS = """
time_key time_24h hour_number minute_number second_number minute_of_day_number
second_of_day_number hour_12_number am_pm_code time_bucket_15m_code
time_bucket_30m_code time_bucket_hour_code business_period_code
is_business_hours is_market_open is_cutoff_time utc_offset_minutes
timezone_code local_time_label time_sort_order market_session_code
shift_code processing_window_code settlement_window_code
""".split()


def label(name: str) -> str:
    return name.replace("_", " ").strip().capitalize()


def data_type(name: str) -> str:
    if name.endswith("_key") or name.endswith("_count") or name.endswith("_number") or name.endswith("_level") or name in {"days_past_due", "installment_number", "repayment_sequence_number"}:
        return "BIGINT"
    if name.startswith("is_") or name.endswith("_flag"):
        return "BOOLEAN"
    if name.endswith("_amount") or name in {"score_value", "quantity", "pnl_amount", "latitude_value", "longitude_value"}:
        return "NUMERIC(20,4)"
    if name.endswith("_rate") or name.endswith("_ratio"):
        return "NUMERIC(14,8)"
    if name.endswith("_at") or name.endswith("_timestamp"):
        return "TIMESTAMPTZ"
    if name.endswith("_date"):
        return "DATE"
    if name.endswith("_description") or name.endswith("_path") or name.endswith("_reference"):
        return "TEXT"
    if name.endswith("_name") or name.endswith("_label"):
        return "VARCHAR(200)"
    if name.endswith("_id") or name.endswith("_hash"):
        return "VARCHAR(100)"
    if name.endswith("_code"):
        return "VARCHAR(50)"
    return "VARCHAR(120)"


def add(columns: list[dict], name: str, description: str, *, nullable: bool = True, origin: str = "synthetic_extension") -> None:
    if any(c["column_name"] == name for c in columns):
        return
    columns.append({
        "ordinal_position": len(columns) + 1,
        "column_name": name,
        "data_type": data_type(name),
        "nullable": nullable,
        "description": description,
        "design_origin": origin,
    })


def build_specs() -> list[dict]:
    specs = []
    for domain, names in DIMENSIONS.items():
        for stem in names.split():
            article = "an" if stem[0] in "aeiou" else "a"
            grain = ("One row per calendar date." if stem == "date" else
                     "One row per time-of-day member." if stem == "time" else
                     f"One row per version of {article} {label(stem).lower()} member.")
            specs.append({"domain": domain, "table_name": "dim_" + stem, "table_type": "dimension", "grain": grain, "stem": stem})
    for domain, names in FACTS.items():
        for stem in names.split():
            grain = (f"One row per {label(stem.removesuffix('_daily')).lower()} per business date." if stem.endswith("_daily") else
                     f"One row per {label(stem.removesuffix('_monthly')).lower()} per accounting month." if stem.endswith("_monthly") else
                     f"One row per recorded {label(stem).lower()} event or calculation.")
            specs.append({"domain": domain, "table_name": "fact_" + stem, "table_type": "fact", "grain": grain, "stem": stem})
    return specs


def target_counts(specs: list[dict]) -> dict[str, int]:
    counts = {}
    small_dimensions = {"currency", "account_status", "card_status", "deposit_term", "loan_purpose", "collateral_type", "credit_rating", "delinquency_band", "facility_type", "merchant_category", "instrument_type", "market", "jurisdiction", "complaint_category", "payment_type", "payment_network"}
    large_dimensions = {"customer", "account", "party", "product", "merchant", "security", "portfolio", "loan_product"}
    for spec in specs:
        name, kind = spec["table_name"], spec["table_type"]
        if name == "dim_date":
            counts[name] = 32
        elif name == "dim_time":
            counts[name] = 24
        elif kind == "dimension":
            counts[name] = 62 if spec["stem"] in large_dimensions else 35 if spec["stem"] in small_dimensions else 45
        else:
            counts[name] = 56 if any(x in name for x in ("transaction", "balance", "risk", "trade", "payment")) else 53
    delta = TARGET_COLUMNS - sum(counts.values())
    names = [s["table_name"] for s in specs if s["table_type"] == "fact"]
    step = 1 if delta > 0 else -1
    for i in range(abs(delta)):
        counts[names[i % len(names)]] += step
    return counts


def dimension_group(stem: str) -> str:
    for group, members in DIM_GROUPS.items():
        if stem in members.split():
            return group
    raise ValueError(f"No dimension profile for {stem}")


def fact_group(spec: dict) -> str:
    domain, stem = spec["domain"], spec["stem"]
    if "rate_daily" in stem:
        return "rate"
    if domain == "risk_compliance":
        return "risk"
    if domain == "customer_service":
        return "service"
    if domain == "wealth":
        return "wealth"
    if domain == "treasury_finance":
        return "treasury"
    if domain == "cards":
        return "card"
    if domain == "payments":
        return "payment"
    if domain == "lending":
        return "loan"
    if "balance" in stem or "usage" in stem:
        return "balance"
    return "transaction"


def dimensions_for_fact(spec: dict) -> list[str]:
    candidates = DIMENSION_KEYS[spec["domain"]].split()
    name = spec["table_name"]
    # The default relationship set is a convenience for a synthetic stress fixture.
    # Optional foreign keys do not assert that every event has every member.
    if name in {"fact_fx_rate_daily", "fact_security_price_daily", "fact_regulatory_capital_daily"}:
        candidates = [x for x in candidates if x not in {"customer", "account"}]
    if "card" in name and "card_product" not in candidates:
        candidates.append("card_product")
    if "loan" in name and "loan_product" not in candidates:
        candidates.append("loan_product")
    if "aml" in name:
        candidates.append("aml_scenario")
    if "fraud" in name:
        candidates.append("fraud_rule")
    return list(dict.fromkeys(candidates))


def make_columns(spec: dict, target: int) -> tuple[list[dict], list[dict]]:
    name, kind, stem = spec["table_name"], spec["table_type"], spec["stem"]
    columns: list[dict] = []
    relationships: list[dict] = []
    pk = f"{stem}_key" if kind == "dimension" else f"{stem}_fact_key"
    add(columns, pk, f"Synthetic surrogate key for {name}.", nullable=False, origin="structural")
    if name == "dim_date":
        for field in DATE_FIELDS:
            if field != pk:
                add(columns, field, f"Calendar attribute: {label(field).lower()}.", nullable=False, origin="calendar")
        return columns, relationships
    if name == "dim_time":
        for field in TIME_FIELDS:
            if field != pk:
                add(columns, field, f"Time attribute: {label(field).lower()}.", nullable=False, origin="calendar")
        return columns, relationships

    if kind == "dimension":
        base = "business_id business_code display_name description effective_from_date effective_to_date is_current is_active source_system_code source_record_id ingested_at updated_at record_hash data_quality_status_code data_owner_code version_number".split()
        for field in base:
            add(columns, field, f"{label(field)} for this {label(stem).lower()} member.", nullable=field not in {"business_id", "effective_from_date", "is_current"}, origin="structural")
        for field in DIM_GROUP_FIELDS[dimension_group(stem)].split():
            add(columns, field, f"Synthetic {label(field).lower()} attribute for {label(stem).lower()}.")
        # Source-specific extension attributes keep wide dimensions distinct.
        for suffix in ("classification_code", "status_code", "risk_band_code", "segment_code", "family_code", "owner_code", "source_reference_id", "review_date", "approval_date", "restriction_flag", "reporting_code", "valuation_method_code", "limit_amount", "standard_rate", "lifecycle_stage_code", "eligibility_code", "purpose_code", "relationship_type_code", "regulatory_treatment_code", "notes_description"):
            add(columns, f"{stem}_{suffix}", f"Synthetic {label(stem).lower()} {label(suffix).lower()}.")
    else:
        add(columns, "business_date_key", "Business date of this fact row.", nullable=False, origin="structural")
        for dim in dimensions_for_fact(spec):
            if dim == "date":
                continue
            fk = f"{dim}_key"
            add(columns, fk, f"Optional key to dim_{dim}.", origin="relationship")
            relationships.append({"from_table": name, "from_column": fk, "to_table": f"dim_{dim}", "to_column": fk, "relationship_type": "many_to_one_optional", "status": "synthetic_candidate"})
        relationships.append({"from_table": name, "from_column": "business_date_key", "to_table": "dim_date", "to_column": "date_key", "relationship_type": "many_to_one_required", "status": "synthetic_candidate"})
        base = "source_system_code source_record_id ingested_at updated_at record_hash data_quality_status_code load_batch_id event_id event_status_code currency_code".split()
        for field in base:
            add(columns, field, f"{label(field)} for this {label(stem).lower()} fact.", origin="structural")
        for field in FACT_PACKS[fact_group(spec)].split() + FACT_COMMON:
            add(columns, field, f"Synthetic {label(field).lower()} for {label(stem).lower()}.")
        for suffix in ("amount", "count", "rate", "status_code", "reason_code", "category_code", "method_code", "reference_id", "effective_date_key", "settlement_date_key", "variance_amount", "adjustment_amount", "is_exception", "is_reversed", "approval_status_code", "source_event_id", "calculation_version_code", "reporting_basis_code", "valuation_amount", "exposure_amount"):
            add(columns, f"{stem}_{suffix}", f"Synthetic {label(stem).lower()} {label(suffix).lower()}.")
    if len(columns) < target:
        raise ValueError(f"Insufficient meaningful candidates for {name}: {len(columns)} < {target}")
    return columns[:target], [r for r in relationships if any(c["column_name"] == r["from_column"] for c in columns[:target])]


def write_csv(path: Path, rows: list[dict], fieldnames: list[str]) -> None:
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def sql_literal(value: object) -> str:
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    if isinstance(value, (int, float)):
        return str(value)
    return "'" + str(value).replace("'", "''") + "'"


def seed_insert(name: str, values: dict[str, object]) -> str:
    return (f"INSERT INTO {SCHEMA}.{name} ({', '.join(values)}) VALUES "
            f"({', '.join(sql_literal(v) for v in values.values())});")


def seed_rows(spec: dict, columns: list[dict]) -> list[str]:
    name, kind = spec["table_name"], spec["table_type"]
    by_name = {c["column_name"]: c for c in columns}
    pk = columns[0]["column_name"]
    rows = []
    if name in {"dim_date", "dim_time"}:
        for n in range(1, 6):
            current = date(2026, 1, 1) + timedelta(days=n - 1)
            values = {}
            for column in columns:
                field, typ = column["column_name"], column["data_type"]
                if field == pk:
                    value = n
                elif field == "calendar_date":
                    value = current.isoformat()
                elif typ == "DATE":
                    value = current.isoformat()
                elif typ == "BOOLEAN":
                    value = n % 2 == 0
                elif typ == "BIGINT":
                    value = n
                else:
                    value = f"sample_{field}_{n}"
                values[field] = value
            rows.append(seed_insert(name, values))
        return rows
    if kind == "dimension":
        for n in range(1, 6):
            values = {pk: n, "business_id": f"{spec['stem']}-{n:03d}", "business_code": f"{spec['stem'][:12]}-{n:03d}",
                      "display_name": f"Sample {label(spec['stem'])} {n}", "effective_from_date": "2025-01-01", "is_current": True}
            rows.append(seed_insert(name, values))
        return rows
    measure_columns = [c for c in columns if c["data_type"].startswith("NUMERIC")]
    for n in range(1, 21):
        values = {pk: n, "business_date_key": ((n - 1) % 5) + 1}
        for dim in dimensions_for_fact(spec):
            fk = f"{dim}_key"
            if fk in by_name and dim != "date":
                values[fk] = ((n - 1) % 5) + 1
        for idx, column in enumerate(measure_columns[:8], start=1):
            field = column["column_name"]
            values[field] = round((n + idx) / 1_000, 5) if field.endswith(("_rate", "_ratio")) else (n * 100 + idx * 7)
        rows.append(seed_insert(name, values))
    return rows


def generate() -> None:
    specs = build_specs()
    assert len(specs) == 100 and len({s["table_name"] for s in specs}) == 100
    target = target_counts(specs)
    ROOT.mkdir(exist_ok=True)
    table_rows, column_rows, relation_rows = [], [], []
    ddl = ["-- Synthetic banking DWH fixture. Execute once in a fresh PostgreSQL database.", f"CREATE SCHEMA IF NOT EXISTS {SCHEMA};", ""]
    seed = ["-- Small deterministic sample: five rows per dimension, twenty per fact.", "-- Values are artificial and have no business validity.", "BEGIN;"]
    dimension_names = {s["table_name"] for s in specs if s["table_type"] == "dimension"}
    for spec in specs:
        name = spec["table_name"]
        columns, relations = make_columns(spec, target[name])
        table_rows.append({"schema_name": SCHEMA, "table_name": name, "table_type": spec["table_type"], "domain": spec["domain"], "grain": spec["grain"], "column_count": len(columns), "design_status": "synthetic_fixture"})
        pk = columns[0]["column_name"]
        for column in columns:
            column_rows.append({"schema_name": SCHEMA, "table_name": name, "table_type": spec["table_type"], "domain": spec["domain"], **column, "is_primary_key": column["column_name"] == pk})
        relation_rows.extend(relations)
        seed.extend(seed_rows(spec, columns))
        ddl.append(f"CREATE TABLE {SCHEMA}.{name} (")
        definitions = [f"    {c['column_name']} {c['data_type']}{'' if c['nullable'] else ' NOT NULL'}" for c in columns]
        definitions.append(f"    CONSTRAINT pk_{name} PRIMARY KEY ({pk})")
        ddl.append(",\n".join(definitions))
        ddl.append(");\n")
    assert len(column_rows) == TARGET_COLUMNS
    assert all(r["to_table"] in dimension_names for r in relation_rows)
    for relation in relation_rows:
        child, col, parent, parent_col = (relation[k] for k in ("from_table", "from_column", "to_table", "to_column"))
        ddl.append(f"ALTER TABLE {SCHEMA}.{child} ADD CONSTRAINT fk_{child}_{col} FOREIGN KEY ({col}) REFERENCES {SCHEMA}.{parent} ({parent_col});")
    ddl.append("")
    seed.extend(["COMMIT;", ""])
    write_csv(ROOT / "tables.csv", table_rows, list(table_rows[0]))
    write_csv(ROOT / "columns.csv", column_rows, list(column_rows[0]))
    write_csv(ROOT / "relationships.csv", relation_rows, list(relation_rows[0]))
    (ROOT / "schema_postgresql.sql").write_text("\n".join(ddl), encoding="utf-8")
    (ROOT / "seed_small.sql").write_text("\n".join(seed), encoding="utf-8")
    manifest = {
        "name": "Synthetic banking DWH SQL-assistant stress fixture",
        "schema": SCHEMA,
        "dialect": "postgresql",
        "table_count": len(table_rows),
        "dimension_count": sum(r["table_type"] == "dimension" for r in table_rows),
        "fact_count": sum(r["table_type"] == "fact" for r in table_rows),
        "column_count": len(column_rows),
        "relationship_count": len(relation_rows),
        "seed_dimension_rows": 42 * 5,
        "seed_fact_rows": 58 * 20,
        "domains": dict(Counter(r["domain"] for r in table_rows)),
        "status": "synthetic_fixture_not_approved_banking_logic",
    }
    (ROOT / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    by_table = {r["table_name"]: {**r, "columns": [], "relationships": []} for r in table_rows}
    for row in column_rows:
        by_table[row["table_name"]]["columns"].append(row)
    for row in relation_rows:
        by_table[row["from_table"]]["relationships"].append(row)
    (ROOT / "catalog.json").write_text(
        json.dumps({"schema_name": SCHEMA, "design_status": "synthetic_fixture", "tables": list(by_table.values())}, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    generate()
