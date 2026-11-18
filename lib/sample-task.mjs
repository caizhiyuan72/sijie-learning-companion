export const sampleTask = {
  id: "geo-isosceles-001",
  version: 2,
  status: "ready",
  grade: "八年级",
  subject: "初中数学·几何证明",
  learningGoal: "能从等腰三角形与中点条件出发，选择全等三角形作为证明工具，并说明每一步依据。",
  title: "等腰三角形底边中线的性质",
  problemText: "如图，在△ABC中，AB＝AC，D是BC的中点。求证：AD⊥BC。",
  diagramPath: "/assets/isosceles-task.svg",
  diagramAlt: "等腰三角形ABC，A在上方，B、D、C依次位于水平底边，连接AD。",
  diagramDescription: "三角形ABC中，A为顶点，B、C为底边端点；AB=AC。D在线段BC上且BD=DC，连接AD。目标是证明AD垂直BC。",
  targetStep: "引导学生利用SSS说明△ABD与△ACD全等，再由对应角相等和邻补角关系得到直角。",
  referenceProof: "∵ AB＝AC，D是BC的中点，∴ BD＝DC。又∵ AD＝AD，∴ △ABD≌△ACD（SSS）。∴ ∠ADB＝∠ADC。又∵ B、D、C三点共线，∴ ∠ADB＋∠ADC＝180°，∴ ∠ADB＝∠ADC＝90°，∴ AD⊥BC。",
  acceptedPaths: [
    "利用SSS证明△ABD与△ACD全等，再证明两个邻补角相等",
    "利用等腰三角形三线合一，但必须说明所用定理与适用条件"
  ],
  hints: [
    {
      id: "h1",
      level: 1,
      dependencies: [],
      kind: "question",
      content: "先观察AD两侧的两个三角形：你已经知道哪两组边分别相等？还有哪条边是它们共有的？"
    },
    {
      id: "h2",
      level: 2,
      dependencies: ["h1"],
      kind: "local_hint",
      content: "把AB＝AC、BD＝DC和公共边AD＝AD放在一起，能用哪一种三角形全等判定？"
    },
    {
      id: "h3",
      level: 3,
      dependencies: ["h1", "h2"],
      kind: "scaffold",
      content: "若已得到△ABD与△ACD全等，请只写出一组对应角相等；再结合B、D、C三点共线，判断这两个角各是多少度。"
    }
  ],
  judgmentCard: {
    statement: "待核验AI建议：因为AB＝AC，所以∠ADB＝∠ADC，因此AD⊥BC。",
    correctVerdict: "不合理",
    reason: "AB＝AC只能直接说明△ABC是等腰三角形，不能直接推出D点处的两个角相等。还需要利用D为中点和公共边AD，证明△ABD与△ACD全等，或引用满足条件的等腰三角形性质。"
  },
  transferTask: {
    text: "变式：在△PQR中，PQ＝PR，M是QR上一点，连接PM。（1）如果只知道PQ＝PR，能否推出PM⊥QR？请说明理由。（2）若再补充QM＝MR，证明PM⊥QR，并说明QM＝MR在证明中起什么作用。",
    diagramDescription: "等腰三角形PQR，P在上方，Q、M、R依次位于底边QR上；M是待判断位置的点，连接PM。图中仅标出PQ＝PR，未预先标出QM＝MR。",
    diagramSpec: {
      width: 600,
      height: 420,
      points: [
        { id: "P", x: 300, y: 40 },
        { id: "Q", x: 90, y: 350 },
        { id: "R", x: 510, y: 350 },
        { id: "M", x: 250, y: 350 }
      ],
      segments: [
        { from: "P", to: "Q" },
        { from: "P", to: "R" },
        { from: "P", to: "M" },
        { from: "Q", to: "R" }
      ],
      labels: [
        { text: "P", point: "P" },
        { text: "Q", point: "Q" },
        { text: "R", point: "R" },
        { text: "M", point: "M" }
      ],
      annotations: [
        { kind: "equal_mark", points: ["P", "Q"] },
        { kind: "equal_mark", points: ["P", "R"] }
      ]
    },
    knowledgePoint: "等腰三角形三线合一的条件作用；SSS全等",
    variantType: "condition_change",
    conditionChange: "先移除M为QR中点（QM＝MR）这一条件，判断PQ＝PR是否足够；再补回QM＝MR完成证明。",
    referenceProof: "（1）不能。仅由PQ＝PR只能说明△PQR是等腰三角形，不能确定M是QR的中点；若M不在QR的中点，PM通常不垂直QR。要推出PM⊥QR，还需要QM＝MR（或直接给出M为QR中点）等条件。（2）补充QM＝MR后，PQ＝PR，QM＝MR，且PM＝PM，所以△PQM≌△PRM（SSS）。因此∠QMP＝∠PMR。又因为Q、M、R三点共线，∠QMP与∠PMR为邻补角，和为180°，所以两角都等于90°，从而PM⊥QR。QM＝MR提供了全等所需的第二组对应边，是从等腰条件得到垂直结论的关键。",
    answerOutline: "评分要点（无需逐字一致）：①第一问明确不能推出，并指出仅有PQ＝PR不足，还缺QM＝MR或M为QR中点；②第二问列出PQ＝PR、QM＝MR、PM＝PM，并用SSS证明△PQM≌△PRM；③由全等写出∠QMP＝∠PMR，结合Q、M、R共线的邻补角关系得两角均为90°，推出PM⊥QR；④说明QM＝MR是建立全等和垂直结论的关键。只答结论或只复述原题，判为依据不足。"
  },
  protectedPhrases: [
    "△ABD≌△ACD",
    "三角形ABD全等于三角形ACD",
    "∠ADB＝∠ADC＝90°",
    "AD⊥BC"
  ],
  safeFallbacks: [
    "我先不替你写完整证明。请从已知条件中选出一条，并说明它能转化成哪一组相等关系。",
    "我们一次只推进一步：AD两侧是哪两个三角形？请先写出它们共有的边。",
    "这一步需要你来判断。请写出你准备使用的判定定理，以及目前还缺少的条件。"
  ]
};
