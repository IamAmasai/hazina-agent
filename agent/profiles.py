"""Onboarding profile assembly. A client's obligations come from independent
switches, never from a single size dropdown (see config/rules.ke.yaml):
income-tax regime x VAT overlay x employer x withholding-agent. Every switch
carries its reason so the merchant — and an auditor — can see why.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from agent import rules  # noqa: E402

TOT_EXCLUDED_STREAMS = {
    "rental_income", "management_fees", "professional_fees", "training_fees",
    "income_subject_to_final_withholding_tax", "employment_income",
    "non_resident_income",
}
TOT_FLOOR = 1_000_000
TOT_CEILING = 25_000_000


def assemble_profile(onboarding):
    """onboarding keys (from config/rules.ke.yaml onboarding_questions):
    legal_form, expected_annual_turnover_kes, income_streams (list),
    taxable_supplies_rolling_12mo_kes, vat_registered_on_itax,
    has_employees, pays_rent_or_professional_fees."""
    reasons = []
    streams = set(onboarding.get("income_streams") or [])
    turnover = onboarding.get("expected_annual_turnover_kes") or 0
    excluded_present = streams & TOT_EXCLUDED_STREAMS
    eligible_streams = streams - TOT_EXCLUDED_STREAMS

    if turnover > TOT_CEILING:
        regime = "standard"
        reasons.append(f"turnover {turnover:,.0f} above the TOT ceiling")
    elif turnover <= TOT_FLOOR:
        regime = "micro_standard"
        reasons.append(f"turnover {turnover:,.0f} at or below the TOT floor — "
                       "standard income tax on profit applies")
    elif streams and not eligible_streams:
        regime = "standard"
        reasons.append("all income streams are TOT-excluded "
                       f"({', '.join(sorted(excluded_present))})")
    else:
        regime = "tot_band"
        reasons.append(f"turnover {turnover:,.0f} inside the TOT band")
        if excluded_present:
            reasons.append("excluded streams carved out of the TOT base: "
                           + ", ".join(sorted(excluded_present)))

    overlays = []
    vat = rules.load_profile("vat_overlay")
    threshold = rules._find_key(vat, "threshold_taxable_supplies_kes")
    supplies = onboarding.get("taxable_supplies_rolling_12mo_kes") or 0
    if onboarding.get("vat_registered_on_itax"):
        overlays.append("vat_registered")
        reasons.append("already VAT-registered on iTax")
    elif supplies >= threshold:
        overlays.append("vat_registered")
        reasons.append(f"taxable supplies {supplies:,.0f} reach the VAT "
                       f"threshold {threshold:,.0f} — registration required")
    if onboarding.get("has_employees"):
        overlays.append("employer")
        reasons.append("has employees — PAYE obligations ride along")
    if onboarding.get("pays_rent_or_professional_fees"):
        overlays.append("withholding_agent")
        reasons.append("pays rent or professional fees — withholding applies")

    return {"income_tax_profile": regime, "overlays": overlays,
            "reasons": reasons,
            "legal_form": onboarding.get("legal_form")}


if __name__ == "__main__":
    salon = assemble_profile({
        "legal_form": "sole_trader", "expected_annual_turnover_kes": 6_000_000,
        "income_streams": ["trading"], "taxable_supplies_rolling_12mo_kes": 6_000_000,
        "vat_registered_on_itax": False, "has_employees": True,
        "pays_rent_or_professional_fees": True})
    assert salon["income_tax_profile"] == "tot_band", salon
    assert "vat_registered" in salon["overlays"], salon

    consultancy = assemble_profile({
        "legal_form": "sole_trader", "expected_annual_turnover_kes": 6_000_000,
        "income_streams": ["professional_fees"],
        "taxable_supplies_rolling_12mo_kes": 6_000_000,
        "vat_registered_on_itax": False, "has_employees": False,
        "pays_rent_or_professional_fees": False})
    assert consultancy["income_tax_profile"] == "standard", consultancy
    assert "vat_registered" in consultancy["overlays"], consultancy

    micro = assemble_profile({
        "legal_form": "sole_trader", "expected_annual_turnover_kes": 600_000,
        "income_streams": ["trading"], "taxable_supplies_rolling_12mo_kes": 600_000,
        "vat_registered_on_itax": False, "has_employees": False,
        "pays_rent_or_professional_fees": False})
    assert micro["income_tax_profile"] == "micro_standard", micro
    assert micro["overlays"] == [], micro
    print("profile assembly self-checks OK")
    for name, p in (("salon", salon), ("consultancy", consultancy), ("micro", micro)):
        print(name, "->", p["income_tax_profile"], p["overlays"])
