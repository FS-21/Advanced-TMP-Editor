import os
import base64
import json

project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ramp_dir = os.path.join(project_root, 'ramp_types')
output_file = os.path.join(project_root, 'ramp_types_b64.json')

result = {}
if os.path.exists(ramp_dir):
    for f in sorted(os.listdir(ramp_dir)):
        if f.endswith('.png'):
            idx = int(f[5:7])  # mslop00.png -> 0
            with open(os.path.join(ramp_dir, f), 'rb') as fp:
                b64 = base64.b64encode(fp.read()).decode('utf-8')
                result[idx] = f"data:image/png;base64,{b64}"

    with open(output_file, 'w', encoding='utf-8') as out:
        json.dump(result, out, indent=2)
    print(f"Generated {len(result)} entries into {output_file}")
else:
    print(f"Directory {ramp_dir} not found")
