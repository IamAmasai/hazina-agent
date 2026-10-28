"""Hazi's rules engine. Reads ONLY config/ — the model never supplies a rate.

Pure functions over the transaction list. Every figure returned carries the
config source it came from so the pack can cite it.
"""
import os

import yaml

ROOT = os.path.join(os.path.dirname(__file__), "..")
CONFIG = os.path.join(ROOT, "config")


def _load(path):
    with open(path) as fh:
        return yaml.safe_load(fh)


def load_master():
    return _load(os.path.join(CONFIG, "rules.ke.yaml"))


def load_profile(name):
    return _load(os.path.join(CONFIG, "profiles", f"{name}.yaml"))


def _find_key(node, key):
    if isinstance(node, dict):
        if key in node:
            return node[key]
        for value in node.values():
            found = _find_key(value, key)
            if found is not None:
                return found
    return None


def tot_rate_for(profile, on_date):
    """Pick the TOT rate effective on a date (YYYY-MM-DD) from rate_history."""
    history = profile.get("rate_history") or []
    chosen = profile.get("rate")
    for entry in history:
        start = str(entry.get("from") or "")
        end = str(entry.get("to") or "9999-12-31")
        if start <= on_date <= end:
            chosen = entry.get("rate")
    return chosen


def compute_tot(transactions, profile, period_last_day):
    """TOT is charged on gross sales from eligible streams only. Expenses are
    never deducted. Transactions carry direction in|out and stream tags."""
    gross = 0.0
    excluded = 0.0
    excluded_streams = set(profile.get("excluded_income") or [])
    for txn in transactions:
        if txn.get("direction") != "in":
            continue
        if txn.get("stream") in excluded_streams:
            excluded += txn["amount_kes"]
        else:
            gross += txn["amount_kes"]
    rate = tot_rate_for(profile, period_last_day)
    return {
        "gross_sales_kes": round(gross, 2),
        "excluded_streams_kes": round(excluded, 2),
        "rate": rate,
        "tot_payable_kes": round(gross * rate, 2),
        "source": "config/profiles/tot_band.yaml (rate_history)",
    }


def rolling_turnover(monthly_gross):
    """monthly_gross: list of (period, amount) oldest→newest. Returns the
    trailing-12-month sum and an annualised projection from the last month."""
    total12 = sum(amount for _, amount in monthly_gross[-12:])
    projection = monthly_gross[-1][1] * 12 if monthly_gross else 0
    return {"trailing_12mo_kes": round(total12, 2),
            "annualised_projection_kes": round(projection, 2)}


def vat_watch(trailing_12mo_taxable_supplies):
    overlay = load_profile("vat_overlay")
    threshold = _find_key(overlay, "threshold_taxable_supplies_kes")
    return {
        "threshold_kes": threshold,
        "trailing_12mo_kes": trailing_12mo_taxable_supplies,
        "headroom_kes": round(threshold - trailing_12mo_taxable_supplies, 2),
        "must_register": trailing_12mo_taxable_supplies >= threshold,
        "source": "config/profiles/vat_overlay.yaml",
    }


def etims_split(expenses):
    """Split expense transactions into eTIMS-backed (deductible) and
    paper-only (disallowed on the standard regime). Expenses are dicts with
    has_etims_invoice True/False."""
    backed = [e for e in expenses if e.get("has_etims_invoice")]
    paper = [e for e in expenses if not e.get("has_etims_invoice")]
    return {
        "etims_backed_kes": round(sum(e["amount_kes"] for e in backed), 2),
        "paper_only_kes": round(sum(e["amount_kes"] for e in paper), 2),
        "paper_only_items": [e.get("id") for e in paper],
        "source": "config/rules.ke.yaml etims (deductibility from 2024-01-01)",
    }


if __name__ == "__main__":
    # Self-check against the hand-verified fictional month (2026-10-28 probe):
    # sales 299,250 → TOT at 1.5% = 4,488.75.
    prof = load_profile("tot_band")
    txns = [{"direction": "in", "amount_kes": 299250.0, "stream": None}]
    out = compute_tot(txns, prof, "2026-10-31")
    assert out["tot_payable_kes"] == 4488.75, out
    print("rules self-check OK:", out)
