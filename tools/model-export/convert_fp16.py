#!/usr/bin/env python
"""Store learned ONNX weights as fp16 while retaining fp32 computation and I/O."""

import argparse
from pathlib import Path

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper


def convert_model(src: Path, out: Path) -> None:
    model = onnx.load(str(src))
    casts = []
    converted = 0
    existing_names = {init.name for init in model.graph.initializer}

    for init in model.graph.initializer:
        if init.data_type != TensorProto.FLOAT:
            continue
        original_name = init.name
        storage_name = f"{original_name}__fp16"
        if storage_name in existing_names:
            raise ValueError(f"{src}: generated tensor name already exists: {storage_name}")

        fp16 = numpy_helper.from_array(
            numpy_helper.to_array(init).astype(np.float16),
            name=storage_name,
        )
        init.CopyFrom(fp16)
        casts.append(
            helper.make_node(
                "Cast",
                [storage_name],
                [original_name],
                name=f"{original_name}__cast_fp32",
                to=TensorProto.FLOAT,
            )
        )
        converted += 1

    if not converted:
        raise ValueError(f"{src}: no fp32 learned initializers found")

    original_nodes = list(model.graph.node)
    del model.graph.node[:]
    model.graph.node.extend(casts)
    model.graph.node.extend(original_nodes)
    out.parent.mkdir(parents=True, exist_ok=True)
    onnx.save(model, str(out))
    print(
        f"{src.name}: stored {converted} learned initializers as fp16; "
        f"wrote {out} ({out.stat().st_size / 1e6:.1f} MB)"
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("src", type=Path)
    parser.add_argument("out", type=Path)
    args = parser.parse_args()
    convert_model(args.src, args.out)


if __name__ == "__main__":
    main()
