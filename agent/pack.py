"""The filing pack — everything up to KRA's door, in KRA's shapes.

For a TOT-band business: tot_values.csv in the iTax TOT workbook's Section
A–E order (see config/formats.yaml) plus a human-readable pack.md carrying the
figures, the watches, the flags and the evidence index. Hazi never files; a
human transfers these values into KRA's own workbook and submits.
"""
import csv
import io
import os


def tot_values_csv(record_data, tot, taxpayer_pin=""):
    """Section order per config/formats.yaml tot_return_companion."""
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["section", "field", "value"])
    w.writerow(["A_return_information", "taxpayer_pin", taxpayer_pin])
    w.writerow(["A_return_information", "type_of_return", "Original"])
    w.writerow(["A_return_information", "return_period", record_data["period"]])
    w.writerow(["D_turnover_and_tax", "gross_monthly_turnover", tot["gross_sales_kes"]])
    w.writerow(["D_turnover_and_tax", "tot_rate", tot["rate"]])
    w.writerow(["D_turnover_and_tax", "tot_payable", tot["tot_payable_kes"]])
    return buf.getvalue()


def pack_markdown(record_data, tot, vat=None, etims=None):
    lines = [
        f"# Filing pack — {record_data['business']} — {record_data['period']}",
        "",
        "Prepared by Hazi (Hazina). A human files on iTax; Hazi never submits.",
        "",
        "## Turnover Tax",
        f"- Gross sales (eligible streams): KSh {tot['gross_sales_kes']:,.2f}",
        f"- Excluded streams (never in the TOT base): KSh {tot['excluded_streams_kes']:,.2f}",
        f"- Rate: {tot['rate'] * 100:.1f}% — source: {tot['source']}",
        f"- **TOT payable: KSh {tot['tot_payable_kes']:,.2f}**",
        "- Due: 20th of the following month. A zero-sales month still files a nil return.",
    ]
    if vat:
        lines += [
            "",
            "## VAT registration watch",
            f"- Trailing 12 months of taxable supplies: KSh {vat['trailing_12mo_kes']:,.2f}",
            f"- Threshold: KSh {vat['threshold_kes']:,.0f} — headroom KSh {vat['headroom_kes']:,.2f}",
            f"- Must register now: {'YES' if vat['must_register'] else 'not yet'}",
        ]
    if etims:
        lines += [
            "",
            "## eTIMS expense split (standard-regime deductibility)",
            f"- eTIMS-backed expenses: KSh {etims['etims_backed_kes']:,.2f}",
            f"- Paper-only expenses (would be disallowed): KSh {etims['paper_only_kes']:,.2f}",
            f"- Paper-only items: {', '.join(etims['paper_only_items']) or 'none'}",
        ]
    open_q = [q for q in record_data["questions"] if q["status"] == "open"]
    lines += ["", "## Open questions for the merchant"]
    if open_q:
        lines += [f"- {q['id']} ({q['transaction_id']}): {q['question']}" for q in open_q]
    else:
        lines.append("- None. Every gap was answered or is flagged below.")
    lines += ["", "## Evidence index"]
    for sha, doc in record_data["documents"].items():
        lines.append(f"- {doc['kind']}: sha256 {sha[:16]}… ({doc['path']})")
    for d in record_data["decisions"]:
        lines.append(f"- decision: {d['kind']} — {d['detail']} "
                     f"(actor: {d['actor']}, attestation: {d.get('attestation_id') or 'pending'})")
    return "\n".join(lines) + "\n"


def write_pack(outdir, record_data, tot, vat=None, etims=None, taxpayer_pin=""):
    os.makedirs(outdir, exist_ok=True)
    with open(os.path.join(outdir, "tot_values.csv"), "w") as fh:
        fh.write(tot_values_csv(record_data, tot, taxpayer_pin))
    with open(os.path.join(outdir, "pack.md"), "w") as fh:
        fh.write(pack_markdown(record_data, tot, vat, etims))
    return outdir
