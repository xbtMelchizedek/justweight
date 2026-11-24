// Local venue: a model you run yourself (Ollama, LM Studio, MLX, llama.cpp). Its marginal API cost is
// zero; electricity and hardware are not counted and are not invented here. unit LOCAL keeps it out of
// the USD ranking, so a free-looking local row never wins a USD comparison by accident.

export const LOCAL_MODELS = [
  {
    model: 'thinkingmachines/inkling-2-mini',
    notes: [
      'runs on your own hardware; API cost 0, electricity and hardware not counted',
      'official minimum: Apple Silicon with 32GB or a 32GB+ GPU (~20GB NVFP4/MXFP8 checkpoint), Apache-2.0',
      'a community 16GB "half experts" build exists; it is a different artifact with different outputs',
      'throughput: measure on your machine (no number is assumed)',
    ],
    source: 'https://huggingface.co/thinkingmachines/Inkling-2-Mini',
  },
];

export function localOffers() {
  return LOCAL_MODELS.map((m) => ({
    provider: 'local',
    network: 'local',
    model: m.model,
    unit: 'LOCAL',
    inPer1M: '0',
    outPer1M: '0',
    privacy: { retention: 'stays on your machine', noRetention: true, tee: false, e2ee: false, local: true },
    notes: m.notes,
    source: m.source,
  }));
}
