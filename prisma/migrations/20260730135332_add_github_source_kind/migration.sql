-- Adds GITHUB to SourceKind for the trending-repos source.
ALTER TYPE "SourceKind" ADD VALUE IF NOT EXISTS 'GITHUB';
