from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


class CodeLocation(BaseModel):
    file: str
    start_line: int
    end_line: int
    symbol: str | None = None


class AgentNode(BaseModel):
    id: str
    name: str
    framework: str | None = None
    location: CodeLocation
    models: list[str] = Field(default_factory=list)
    tools: list[str] = Field(default_factory=list)
    prompts: list[str] = Field(default_factory=list)


class ToolNode(BaseModel):
    id: str
    name: str
    location: CodeLocation
    framework: str | None = None
    callable_from_agent: bool = False
    side_effects: list[str] = Field(default_factory=list)
    requires_approval: bool = False
    metadata: dict = Field(default_factory=dict)


class ModelNode(BaseModel):
    id: str
    provider: str | None = None
    model_name: str | None = None
    purpose: str | None = None
    location: CodeLocation


class PromptNode(BaseModel):
    id: str
    name: str
    text_preview: str
    location: CodeLocation
    used_by_models: list[str] = Field(default_factory=list)


class RouteNode(BaseModel):
    id: str
    method: str
    path: str
    location: CodeLocation
    auth_guards: list[str] = Field(default_factory=list)
    metadata: dict = Field(default_factory=dict)


class SourceNode(BaseModel):
    id: str
    kind: str
    label: str
    location: CodeLocation
    trusted: bool = False


class SinkNode(BaseModel):
    id: str
    kind: str
    label: str
    location: CodeLocation
    impact: Literal["low", "medium", "high", "critical"] = "medium"


class GuardNode(BaseModel):
    id: str
    kind: str
    label: str
    location: CodeLocation


class DataFlowEdge(BaseModel):
    src: str
    dst: str
    kind: Literal["calls", "uses_tool", "uses_model", "uses_prompt", "flows_to", "guarded_by", "reads", "writes"]
    location: CodeLocation | None = None


class AgentIR(BaseModel):
    agents: list[AgentNode] = Field(default_factory=list)
    tools: list[ToolNode] = Field(default_factory=list)
    models: list[ModelNode] = Field(default_factory=list)
    prompts: list[PromptNode] = Field(default_factory=list)
    routes: list[RouteNode] = Field(default_factory=list)
    sources: list[SourceNode] = Field(default_factory=list)
    sinks: list[SinkNode] = Field(default_factory=list)
    guards: list[GuardNode] = Field(default_factory=list)
    edges: list[DataFlowEdge] = Field(default_factory=list)

    def add_edge(self, src: str, dst: str, kind: str, location: CodeLocation | None = None) -> None:
        if src == dst:
            return
        e = DataFlowEdge(src=src, dst=dst, kind=kind, location=location)
        if e not in self.edges:
            self.edges.append(e)

    def all_node_ids(self) -> set[str]:
        return {
            *(x.id for x in self.agents),
            *(x.id for x in self.tools),
            *(x.id for x in self.models),
            *(x.id for x in self.prompts),
            *(x.id for x in self.routes),
            *(x.id for x in self.sources),
            *(x.id for x in self.sinks),
            *(x.id for x in self.guards),
        }
