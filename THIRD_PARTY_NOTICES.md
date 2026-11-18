# 第三方软件与开源项目使用声明

本文件区分“开源机制与代码”“团队自主产品规则”“模型能力”。开源代码本身不作为作品创新点。

## OATutor

- 仓库：https://github.com/CAHLR/OATutor
- 固定提交：`6c729b7192c084367348b87486f70846463e3902`
- 许可证：MIT，副本见 `licenses/OATutor-MIT.txt`
- 使用范围：参考并改写提示依赖关系、逐级解锁和提示事件记录机制。
- 进入运行端：是，但仅为团队用原生 JavaScript 重新实现的状态机 `lib/state-machine.mjs`。
- 主要差异：未引入 React 16、Material UI 4、Firebase、AWS、BKT、英文题库或原界面；新增“先思—判别—迁移—反思”、服务端阶段校验和匿名事件追溯。

## SocraticBench

- 仓库：https://github.com/GiovanniGatti/socratic-bench
- 固定提交：`5bf0f8ffa246d45c4e084ec8ecb3abd6a8e9a1d3`
- 许可证：MIT，上游许可证中的版权文本按原样保留，副本见 `licenses/SocraticBench-MIT.txt`
- 使用范围：开发评测目录中的 `TeacherAgent`、`StudentAgent`、`JudgeAgent` 与苏格拉底评价维度。
- 进入运行端：否。固定源码仅位于 `evaluation/vendor/socratic-bench`。
- 主要差异：增加 DeepSeek OpenAI 兼容适配；绕过模型列表健康检查；修正固定版本 `pyproject.toml` 中 `dependnecies` 拼写造成的依赖遗漏并使用 `requirements.lock.txt`；覆盖为中文初中几何规则；加入答案泄露、单步推进和无意义连续反问指标。

## KaTeX

- 仓库：https://github.com/KaTeX/KaTeX
- npm 版本：`0.16.22`，锁定于 `package-lock.json`
- 许可证：MIT，副本见 `licenses/KaTeX-MIT.txt`
- 使用范围：学生端数学符号显示。
- 进入运行端：是。

## 明确未引入

- OpenTutor：架构和代码量超过本 MVP 范围。
- DeepTutor：平台范围过大，会削弱单一问题主线。
- Studyield：AGPL 许可和复杂服务架构不适合当前交付。
- MathDial、MathTutorBench：未确认与本次使用方式相匹配的清晰标准许可证，因此不复制数据。

## 团队自主部分

“先思—求助—判别—迁移反思”四阶段产品流程、中文初中几何学习编排规则、防泄露保护片段、匿名学习记录和所有界面均为本项目自主设计与实现。DeepSeek用于题目识别、内容生成、二次核验和宽松过程判定；AI核验用于降低错误，但不宣称完全消除识题或出题错误。
