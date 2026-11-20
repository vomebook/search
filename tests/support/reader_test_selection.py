import collections
import unittest

from tests.performance.test_reader_performance import ReaderPerformanceTest


CATEGORY_METHODS = {
    "layout": (
        "test_pdf_rendering_has_bounded_concurrency_and_canvas_memory",
        "test_long_native_pdf_keeps_bounded_page_shells",
        "test_pdf_exposes_lazy_accessible_text",
        "test_native_pdf_canvas_does_not_wait_for_text_layer",
        "test_reader_panel_bookmark_search_and_theme",
        "test_reader_controls_fit_viewport_without_overlap_and_work_on_mobile",
        "test_reader_toolbar_controls_have_accessible_names_and_state",
        "test_mobile_pdf_rendering_uses_one_slot_and_seven_canvases",
        "test_high_density_mobile_pdf_uses_backing_scale_without_distortion",
        "test_mobile_zoom_enlarges_pdf_page_without_resizing_content_shell",
    ),
    "formats": (
        "test_format_modes_expose_matching_controls_and_bookmark_ui",
        "test_video_failure_shows_recoverable_reader_error",
        "test_video_extension_aliases_report_media_errors_consistently",
        "test_unsupported_format_hides_inapplicable_controls",
        "test_txt_displays_before_stream_finishes_and_preserves_split_utf8",
        "test_text_reader_uses_scroll_mode_without_pagination_controls",
        "test_reader_tab_is_hidden_for_document_without_toc",
        "test_scanned_pdf_bookmark_has_empty_excerpt",
         "test_txt_detects_gb18030_and_utf16_bom",
        "test_txt_detects_encoding_across_tiny_initial_chunks",
        "test_html_aliases_render_safely_with_visible_text",
        "test_malicious_html_css_and_svg_are_inert_and_keep_safe_text",
        "test_markdown_extension_aliases_render_content",
        "test_image_aliases_decode_real_image_bytes",
        "test_native_media_uses_proxy_controls_and_mobile_layout",
        "test_mobile_audio_keeps_folder_action_in_playback_panel",
        "test_audio_extension_aliases_use_native_reader_controls",
        "test_cold_cache_first_read_with_real_format_engines",
    ),
    "conversions": (
        "test_djvu_source_revision_failure_and_retry",
        "test_djvu_range_jump_renders_complete_page",
        "test_djvu_disposal_stops_source_requests",
        "test_converted_pdf_pages_reject_invalid_manifests",
        "test_invalid_direct_pdf_manifest_does_not_retry_through_proxy",
        "test_djvu_legacy_stream_is_rejected_without_page_images",
        "test_djvu_canvas_fits_page_without_overflow",
        "test_djvu_embedded_text_double_click_and_drag_select",
        "test_djvu_ocr_uses_verified_source_and_versioned_paths",
        "test_djvu_touch_swipe_from_ocr_does_not_select_or_jump",
        "test_djvu_touch_swipe_preserves_ocr_selection",
        "test_long_pdf_virtualizes_and_navigates_to_distant_page",
        "test_oversized_chapter_manifest_and_response_use_resource_limit",
        "test_image_proxy_failure_recovers_on_manual_retry_without_direct_source",
        "test_fetch_formats_keep_proxy_failure_until_manual_retry",
    ),
    "navigation": (
        "test_reader_controls_honor_boundaries_and_keyboard_activation",
        "test_text_bookmark_uses_progress_excerpt_and_highlights_search",
        "test_full_text_search_lists_highlighted_snippets_and_jumps",
        "test_pdf_allows_two_bookmarks_on_one_page_and_restores_offsets",
        "test_html_bookmark_at_zero_restores_iframe_top",
        "test_html_restores_and_saves_internal_scroll_position",
        "test_actual_store_broadcasts_progress_and_bookmark_updates_between_readers",
        "test_html_and_markdown_toc_click_navigation",
        "test_pdf_outline_click_navigates_to_declared_page",
        "test_pdf_outline_jump_scrolls_before_target_render_finishes",
        "test_pdf_outline_marks_current_entry_when_page_changes",
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
        "test_pdf_outline_does_not_delay_ready",
        "test_late_pdf_outline_reconciles_reading_panel_without_losing_selected_tab",
        "test_pagehide_before_restoration_does_not_overwrite_progress",
        "test_blocked_v1_upgrade_does_not_block_document_loading",
        "test_stale_bookmark_query_cannot_overwrite_all_bookmarks",
        "test_reader_store_preserves_old_history_and_keeps_current_bookmarks",
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
