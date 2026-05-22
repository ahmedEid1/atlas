"""Parse a PDF from S3 to markdown using marker-pdf and write the result back.

Invocation:
    python parse_pdf.py <bucket> <in_key> <out_key>

Stdout (single line):
    {"ok": true, "out_key": "...", "page_count": N, "char_count": N}
"""
from __future__ import annotations

import json
import os
import sys
import tempfile

import boto3

from marker.converters.pdf import PdfConverter
from marker.models import create_model_dict
from marker.output import text_from_rendered


def _s3():
    return boto3.client(
        "s3",
        endpoint_url=os.environ["S3_ENDPOINT"],
        region_name=os.environ["S3_REGION"],
        aws_access_key_id=os.environ["S3_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["S3_SECRET_ACCESS_KEY"],
    )


def main(argv: list[str]) -> int:
    if len(argv) != 4:
        print(json.dumps({"ok": False, "error": "usage: parse_pdf.py <bucket> <in_key> <out_key>"}), file=sys.stderr)
        return 2

    bucket, in_key, out_key = argv[1], argv[2], argv[3]

    s3 = _s3()
    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tmp:
        local_in = tmp.name
    s3.download_file(bucket, in_key, local_in)

    converter = PdfConverter(artifact_dict=create_model_dict())
    rendered = converter(local_in)
    text, _ext, _images = text_from_rendered(rendered)

    s3.put_object(
        Bucket=bucket,
        Key=out_key,
        Body=text.encode("utf-8"),
        ContentType="text/markdown",
    )

    page_count = len(getattr(rendered, "metadata", {}).get("page_stats", []) or [])
    print(json.dumps({"ok": True, "out_key": out_key, "page_count": page_count, "char_count": len(text)}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
