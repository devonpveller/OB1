// Each module registers its own panel (and nav entry) when imported - this file only loads them.
// Adding an area is adding a module and one import line; no entry in another module changes.
import "./document/DocumentPanel";
import "./documents/DocumentsPanel";
import "./reference/ReferencePanel";
import "./docrefs/DocReferencesPanel";
import "./search/SearchPanel";
import "./hubs/HubsPanel";
import "./refinery/RefineryPanel";
import "./docmeta/DocMetaPanels";
import "./sessions/SessionsPanel";
import "./flow/ResearchFlowPanel";
import "./export/ExportPanel";
import "./trust/TrustPanels";
import "./room/RoomPanels";
// research-workbench P8a-1: the timeline, the trail and the page graph
import "./timeline/TimelinePanel";
import "./trail/TrailPanel";
import "./graph/PageGraphPanel";
import "./cleanup/CleanupPanel";
import "./intake/IntakePanel";
// research-workbench rw-p8a4-ideas: the ideas panel, the idea view (= the refinery view) and its context graph
import "./ideas/IdeasPanel";
import "./ideas/IdeaPanel";
