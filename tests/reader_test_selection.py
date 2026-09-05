import collections
import unittest

from tests.test_reader_performance import ReaderPerformanceTest


CATEGORY_METHODS = {
    "layout": (
        "test_pdf_rendering_has_bounded_concurrency_and_canvas_memory",
        "test_pdf_exposes_lazy_accessible_text",
        "test_reader_panel_bookmark_search_and_theme",
        "test_reader_controls_fit_viewport_without_overlap_and_work_on_mobile",
        "test_reader_toolbar_controls_have_accessible_names_and_state",
        "test_mobile_pdf_rendering_uses_one_slot_and_seven_canvases",
        "test_mobile_zoom_enlarges_pdf_page_without_resizing_content_shell",
    ),
    "formats": (
        "test_format_modes_expose_matching_controls_and_bookmark_ui",
        "test_video_failure_shows_recoverable_reader_error",
        "test_video_extension_aliases_report_media_errors_consistently",
        "test_unsupported_format_hides_inapplicable_controls",
        "test_truncated_epub_reports_source_damage",
        "test_txt_displays_before_stream_finishes_and_preserves_split_utf8",
        "test_text_reader_uses_scroll_mode_without_pagination_controls",
        "test_reader_tab_remains_visible_for_document_without_toc",
        "test_txt_detects_gb18030_and_utf16_bom",
        "test_txt_detects_encoding_across_tiny_initial_chunks",
        "test_html_aliases_render_safely_with_visible_text",
        "test_malicious_html_css_and_svg_are_inert_and_keep_safe_text",
        "test_markdown_extension_aliases_render_content",
        "test_image_aliases_decode_real_image_bytes",
        "test_native_media_uses_proxy_controls_and_mobile_layout",
        "test_audio_extension_aliases_use_native_reader_controls",
        "test_cold_cache_first_read_with_real_format_engines",
    ),
    "conversions": (
        "test_converted_pdf_pages_reject_invalid_manifest_and_missing_first_page",
        "test_converted_pdf_pages_report_error_when_later_page_is_missing",
        "test_converted_pdf_pages_fit_wide_images_without_overlap",
        "test_oversized_chapter_manifest_and_response_use_resource_limit",
        "test_zip_bomb_metadata_is_rejected_before_docx_and_foliate_parsers",
        "test_image_proxy_failure_falls_back_to_direct_source",
        "test_fetch_formats_fall_back_when_proxy_request_rejects",
        "test_foliate_normalizes_legacy_chm_markup_and_keeps_resources",
    ),
    "navigation": (
        "test_reader_controls_honor_boundaries_and_keyboard_activation",
        "test_text_bookmark_uses_progress_excerpt_and_highlights_search",
        "test_full_text_search_lists_highlighted_snippets_and_jumps",
        "test_pdf_allows_two_bookmarks_on_one_page_and_restores_offsets",
        "test_html_bookmark_at_zero_restores_iframe_top",
        "test_foliate_navigation_path_dark_links_and_unique_sections",
        "test_foliate_rapid_toc_navigation_keeps_latest_destination",
        "test_foliate_failed_toc_section_can_retry",
        "test_foliate_duplicate_toc_navigation_shares_section_load",
        "test_foliate_chapter_buttons_use_continuous_reader_navigation",
        "test_foliate_scroll_updates_toc_on_animation_frame",
        "test_foliate_resize_keeps_current_text_anchor",
        "test_foliate_virtualizes_distant_sections_and_reloads_them",
        "test_foliate_full_search_uses_continuous_reader_navigation",
        "test_foliate_bookmark_restores_continuous_section_position",
        "test_foliate_progress_slider_uses_continuous_viewport",
        "test_foliate_history_saves_structured_section_position",
        "test_foliate_history_restores_structured_section_position",
        "test_html_restores_and_saves_internal_scroll_position",
        "test_actual_store_broadcasts_progress_and_bookmark_updates_between_readers",
        "test_html_and_markdown_toc_click_navigation",
        "test_pdf_outline_click_navigates_to_declared_page",
        "test_epub_chapters_load_first_lazy_next_and_toc_destination",
    ),
    "lifecycle": (
        "test_fetch_file_aborts_when_pagehide_disposes_reader",
        "test_concurrent_fetch_file_callers_receive_complete_bodies",
        "test_id_only_resolver_is_lifecycle_managed",
        "test_id_only_resolver_failure_uses_reader_error_ui",
        "test_id_only_reader_source_uses_authoritative_resolve",
        "test_id_only_reader_falls_back_to_session_source_when_resolve_fails",
        "test_reader_starts_with_session_metadata_before_document_load",
        "test_document_preparation_overlaps_delayed_history_restore",
        "test_pagehide_before_restoration_does_not_overwrite_progress",
        "test_blocked_v1_upgrade_does_not_block_document_loading",
        "test_stale_bookmark_query_cannot_overwrite_all_bookmarks",
        "test_reader_store_migrates_history_and_keeps_bookmarks_when_cleared",
        "test_supported_formats_start_loading_while_history_restores",
    ),
}


def validate_partition():
    source = {
        name for name, value in ReaderPerformanceTest.__dict__.items()
        if name.startswith("test_") and callable(value)
    }
    assigned = [name for methods in CATEGORY_METHODS.values() for name in methods]
    counts = collections.Counter(assigned)
    missing = sorted(source - counts.keys())
    unknown = sorted(counts.keys() - source)
    duplicates = sorted(name for name, count in counts.items() if count > 1)
    if missing or unknown or duplicates:
        raise AssertionError(
            f"invalid Reader test partition: missing={missing}, unknown={unknown}, "
            f"duplicates={duplicates}"
        )
    return {category: len(methods) for category, methods in CATEGORY_METHODS.items()}


def load_category_tests(loader, category):
    validate_partition()
    return loader.loadTestsFromNames(CATEGORY_METHODS[category], ReaderPerformanceTest)


class ReaderPartitionContractTest(unittest.TestCase):
    def test_every_reader_performance_test_is_assigned_once(self):
        self.assertEqual(sum(validate_partition().values()), len(set(
            name for methods in CATEGORY_METHODS.values() for name in methods
        )))
