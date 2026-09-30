import json, math, sys
# usage: vs.py A.jsonl B.jsonl  -> paired B/A over common (scenario, fleet, seed)
def load(f): return {(r['scenario'], r['fleet'], r['seed']): r for r in map(json.loads, open(f)) if r.get('system') == 'ace'}
a, b = load(sys.argv[1]), load(sys.argv[2])
ks = [k for k in a if k in b]
for fl in sorted({k[1] for k in ks}):
    kk = [k for k in ks if k[1] == fl]
    g = math.exp(sum(math.log(b[k]['thr'] / a[k]['thr']) for k in kk) / len(kk))
    w = sum(1 for k in kk if (b[k]['done'], b[k]['thr']) > (a[k]['done'], a[k]['thr']))
    l = sum(1 for k in kk if (b[k]['done'], b[k]['thr']) < (a[k]['done'], a[k]['thr']))
    na, nb = sum(a[k]['near'] for k in kk), sum(b[k]['near'] for k in kk)
    da, db = sum(a[k]['done'] for k in kk), sum(b[k]['done'] for k in kk)
    print(f"fleet {fl} n={len(kk)} thr B/A geo={g:.3f} B better/worse={w}/{l} done {da}->{db} near {na}->{nb} near/task {na/da:.3f}->{nb/db:.3f}")
