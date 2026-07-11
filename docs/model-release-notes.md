Size-optimized Demucs ONNX models for native and browser inference. These are derived artifacts based on the [upstream Demucs models](https://github.com/adefossez/demucs) and the ONNX export work in [adefossez/demucs#10](https://github.com/adefossez/demucs/pull/10).

Download one of these sets:

- Standard four-stem and two-stem modes: `dft.bin` and `htdemucs.onnx`.
- Fine-tuned target/minus mode: `dft.bin` and the corresponding `htdemucs_ft_<source>.onnx` specialist.
- Full fine-tuned support: `dft.bin` and all four fine-tuned specialists.

Every ONNX model references the shared `dft.bin` external-data file. Keep both files in the same directory for native ONNX Runtime, or supply `dft.bin` through ONNX Runtime Web's external-data API.
