"""v3 pipeline modules. Each module is a subclass of biblion.framework.Module."""
from .acquire_seeds          import AcquireSeeds
from .expand_seeds           import ExpandSeeds
from .merge_identities       import MergeIdentities
from .resolve_dois_oa        import ResolveDoisOa
from .resolve_dois_s2        import ResolveDoisS2
from .resolve_dois_via_s2id  import ResolveDoisViaS2Id
from .resolve_dois_via_pmid  import ResolveDoisViaPmid
from .enrich_metadata_oa     import EnrichMetadataOa
from .enrich_metadata_s2     import EnrichMetadataS2
from .enrich_metadata_ncbi   import EnrichMetadataNcbi
from .enrich_stubs_oa        import EnrichStubsOa
from .bulk_paper_ids         import BulkPaperIds
from .bulk_abstracts         import BulkAbstracts
from .bulk_papers            import BulkPapers
from .expand_papers_s2       import ExpandPapersS2
from .expand_incoming_oa     import ExpandIncomingOa
from .search_s2_factorial    import SearchS2Factorial
from .import_ris              import ImportRis

# Default registration order (placeholders first, then real producers).
ALL_MODULES = [
    AcquireSeeds,
    ExpandSeeds,
    MergeIdentities,
    ResolveDoisOa,
    ResolveDoisS2,
    ResolveDoisViaS2Id,
    ResolveDoisViaPmid,
    EnrichMetadataOa,
    EnrichMetadataS2,
    EnrichMetadataNcbi,
    EnrichStubsOa,
    BulkPaperIds,
    BulkAbstracts,
    BulkPapers,
    ExpandPapersS2,
    ExpandIncomingOa,
    SearchS2Factorial,
    ImportRis,
]

__all__ = [
    'AcquireSeeds', 'ExpandSeeds', 'MergeIdentities',
    'ResolveDoisOa', 'ResolveDoisS2', 'ResolveDoisViaS2Id', 'ResolveDoisViaPmid',
    'EnrichMetadataOa', 'EnrichMetadataS2', 'EnrichMetadataNcbi', 'EnrichStubsOa',
    'BulkPaperIds', 'BulkAbstracts', 'BulkPapers',
    'ExpandPapersS2', 'ExpandIncomingOa', 'SearchS2Factorial', 'ImportRis',
    'ALL_MODULES',
]
