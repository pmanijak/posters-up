export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      _migration_date_backfill_log: {
        Row: {
          date_raw: string | null
          event_id: string
          id: number
          migrated_at: string | null
          new_date_start: string | null
          new_date_type: string | null
          old_date_start: string | null
          old_date_type: string | null
          reason: string | null
        }
        Insert: {
          date_raw?: string | null
          event_id: string
          id?: number
          migrated_at?: string | null
          new_date_start?: string | null
          new_date_type?: string | null
          old_date_start?: string | null
          old_date_type?: string | null
          reason?: string | null
        }
        Update: {
          date_raw?: string | null
          event_id?: string
          id?: number
          migrated_at?: string | null
          new_date_start?: string | null
          new_date_type?: string | null
          old_date_start?: string | null
          old_date_type?: string | null
          reason?: string | null
        }
        Relationships: []
      }
      board_flyers: {
        Row: {
          board_id: string
          created_at: string
          event_id: string
          first_seen_at: string
          id: string
          is_active: boolean
          last_seen_at: string
          removed_at: string | null
        }
        Insert: {
          board_id: string
          created_at?: string
          event_id: string
          first_seen_at?: string
          id?: string
          is_active?: boolean
          last_seen_at?: string
          removed_at?: string | null
        }
        Update: {
          board_id?: string
          created_at?: string
          event_id?: string
          first_seen_at?: string
          id?: string
          is_active?: boolean
          last_seen_at?: string
          removed_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "board_flyers_board_id_fkey"
            columns: ["board_id"]
            isOneToOne: false
            referencedRelation: "boards"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "board_flyers_board_id_fkey"
            columns: ["board_id"]
            isOneToOne: false
            referencedRelation: "boards_public"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "board_flyers_board_id_fkey"
            columns: ["board_id"]
            isOneToOne: false
            referencedRelation: "event_board_locations"
            referencedColumns: ["board_id"]
          },
          {
            foreignKeyName: "board_flyers_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "board_flyers_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "events_public"
            referencedColumns: ["id"]
          },
        ]
      }
      board_submissions: {
        Row: {
          ai_review_note: string | null
          board_id: string
          corrected_description: string | null
          created_at: string
          description: string | null
          id: string
          location_name: string | null
          photo_id: string | null
          requires_entry_to_photograph: boolean | null
          requires_entry_to_post: boolean | null
          review_status: string
          reviewed_at: string | null
          submitted_at: string
          submitted_by: string | null
        }
        Insert: {
          ai_review_note?: string | null
          board_id: string
          corrected_description?: string | null
          created_at?: string
          description?: string | null
          id?: string
          location_name?: string | null
          photo_id?: string | null
          requires_entry_to_photograph?: boolean | null
          requires_entry_to_post?: boolean | null
          review_status?: string
          reviewed_at?: string | null
          submitted_at?: string
          submitted_by?: string | null
        }
        Update: {
          ai_review_note?: string | null
          board_id?: string
          corrected_description?: string | null
          created_at?: string
          description?: string | null
          id?: string
          location_name?: string | null
          photo_id?: string | null
          requires_entry_to_photograph?: boolean | null
          requires_entry_to_post?: boolean | null
          review_status?: string
          reviewed_at?: string | null
          submitted_at?: string
          submitted_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "board_submissions_board_id_fkey"
            columns: ["board_id"]
            isOneToOne: false
            referencedRelation: "boards"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "board_submissions_board_id_fkey"
            columns: ["board_id"]
            isOneToOne: false
            referencedRelation: "boards_public"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "board_submissions_board_id_fkey"
            columns: ["board_id"]
            isOneToOne: false
            referencedRelation: "event_board_locations"
            referencedColumns: ["board_id"]
          },
          {
            foreignKeyName: "board_submissions_photo_id_fkey"
            columns: ["photo_id"]
            isOneToOne: false
            referencedRelation: "photos"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "board_submissions_submitted_by_fkey"
            columns: ["submitted_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      boards: {
        Row: {
          allowed_content_types: string[] | null
          created_at: string
          current_state_photo_id: string | null
          description: string | null
          first_sighted_at: string
          geo_city: string | null
          geo_country: string | null
          geo_neighborhood: string | null
          geo_region: string | null
          geolocation: unknown
          id: string
          is_active: boolean
          last_sighted_at: string
          location_name: string | null
          managed_by: string | null
          posting_policy: string | null
          requires_entry_to_photograph: boolean | null
          requires_entry_to_post: boolean | null
          updated_at: string
        }
        Insert: {
          allowed_content_types?: string[] | null
          created_at?: string
          current_state_photo_id?: string | null
          description?: string | null
          first_sighted_at?: string
          geo_city?: string | null
          geo_country?: string | null
          geo_neighborhood?: string | null
          geo_region?: string | null
          geolocation: unknown
          id?: string
          is_active?: boolean
          last_sighted_at?: string
          location_name?: string | null
          managed_by?: string | null
          posting_policy?: string | null
          requires_entry_to_photograph?: boolean | null
          requires_entry_to_post?: boolean | null
          updated_at?: string
        }
        Update: {
          allowed_content_types?: string[] | null
          created_at?: string
          current_state_photo_id?: string | null
          description?: string | null
          first_sighted_at?: string
          geo_city?: string | null
          geo_country?: string | null
          geo_neighborhood?: string | null
          geo_region?: string | null
          geolocation?: unknown
          id?: string
          is_active?: boolean
          last_sighted_at?: string
          location_name?: string | null
          managed_by?: string | null
          posting_policy?: string | null
          requires_entry_to_photograph?: boolean | null
          requires_entry_to_post?: boolean | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "fk_boards_current_state_photo"
            columns: ["current_state_photo_id"]
            isOneToOne: false
            referencedRelation: "photos"
            referencedColumns: ["id"]
          },
        ]
      }
      config: {
        Row: {
          description: string | null
          key: string
          updated_at: string
          value: string
        }
        Insert: {
          description?: string | null
          key: string
          updated_at?: string
          value: string
        }
        Update: {
          description?: string | null
          key?: string
          updated_at?: string
          value?: string
        }
        Relationships: []
      }
      contact_messages: {
        Row: {
          category: string
          context_url: string | null
          created_at: string
          email: string | null
          event_id: string | null
          id: string
          message: string
          status: string
        }
        Insert: {
          category?: string
          context_url?: string | null
          created_at?: string
          email?: string | null
          event_id?: string | null
          id?: string
          message: string
          status?: string
        }
        Update: {
          category?: string
          context_url?: string | null
          created_at?: string
          email?: string | null
          event_id?: string | null
          id?: string
          message?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "contact_messages_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contact_messages_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "events_public"
            referencedColumns: ["id"]
          },
        ]
      }
      event_reports: {
        Row: {
          created_at: string
          event_id: string
          id: string
          note: string | null
          report_type: string
          reported_by: string | null
          resolution_note: string | null
          resolved_at: string | null
          resolved_by: string | null
          status: string
        }
        Insert: {
          created_at?: string
          event_id: string
          id?: string
          note?: string | null
          report_type: string
          reported_by?: string | null
          resolution_note?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          status?: string
        }
        Update: {
          created_at?: string
          event_id?: string
          id?: string
          note?: string | null
          report_type?: string
          reported_by?: string | null
          resolution_note?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "event_reports_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "event_reports_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "events_public"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "event_reports_reported_by_fkey"
            columns: ["reported_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      event_sightings: {
        Row: {
          board_id: string | null
          created_at: string
          enrichment_data: Json | null
          enrichment_source: string | null
          event_id: string
          extraction_confidence: number
          flyer_style: string | null
          id: string
          match_type: string | null
          photo_id: string | null
          raw_extraction: Json
          review_status: string
          reviewed_at: string | null
          reviewed_by: string | null
          sighted_at: string
        }
        Insert: {
          board_id?: string | null
          created_at?: string
          enrichment_data?: Json | null
          enrichment_source?: string | null
          event_id: string
          extraction_confidence?: number
          flyer_style?: string | null
          id?: string
          match_type?: string | null
          photo_id?: string | null
          raw_extraction: Json
          review_status?: string
          reviewed_at?: string | null
          reviewed_by?: string | null
          sighted_at?: string
        }
        Update: {
          board_id?: string | null
          created_at?: string
          enrichment_data?: Json | null
          enrichment_source?: string | null
          event_id?: string
          extraction_confidence?: number
          flyer_style?: string | null
          id?: string
          match_type?: string | null
          photo_id?: string | null
          raw_extraction?: Json
          review_status?: string
          reviewed_at?: string | null
          reviewed_by?: string | null
          sighted_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "event_sightings_board_id_fkey"
            columns: ["board_id"]
            isOneToOne: false
            referencedRelation: "boards"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "event_sightings_board_id_fkey"
            columns: ["board_id"]
            isOneToOne: false
            referencedRelation: "boards_public"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "event_sightings_board_id_fkey"
            columns: ["board_id"]
            isOneToOne: false
            referencedRelation: "event_board_locations"
            referencedColumns: ["board_id"]
          },
          {
            foreignKeyName: "event_sightings_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "event_sightings_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "events_public"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "event_sightings_photo_id_fkey"
            columns: ["photo_id"]
            isOneToOne: false
            referencedRelation: "photos"
            referencedColumns: ["id"]
          },
        ]
      }
      event_talent: {
        Row: {
          billing_position: number | null
          confirmed: boolean
          created_at: string
          event_id: string
          id: string
          role: string | null
          talent_id: string
        }
        Insert: {
          billing_position?: number | null
          confirmed?: boolean
          created_at?: string
          event_id: string
          id?: string
          role?: string | null
          talent_id: string
        }
        Update: {
          billing_position?: number | null
          confirmed?: boolean
          created_at?: string
          event_id?: string
          id?: string
          role?: string | null
          talent_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "event_talent_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "event_talent_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "events_public"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "event_talent_talent_id_fkey"
            columns: ["talent_id"]
            isOneToOne: false
            referencedRelation: "talent"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "event_talent_talent_id_fkey"
            columns: ["talent_id"]
            isOneToOne: false
            referencedRelation: "talent_public"
            referencedColumns: ["id"]
          },
        ]
      }
      event_verifications: {
        Row: {
          created_at: string
          event_id: string
          id: string
          source_type: string
          source_url: string
          source_url_normalized: string | null
          trust_weight: number
          verified_at: string
          verified_by: string
          verified_fields: Json | null
        }
        Insert: {
          created_at?: string
          event_id: string
          id?: string
          source_type: string
          source_url: string
          source_url_normalized?: string | null
          trust_weight: number
          verified_at?: string
          verified_by?: string
          verified_fields?: Json | null
        }
        Update: {
          created_at?: string
          event_id?: string
          id?: string
          source_type?: string
          source_url?: string
          source_url_normalized?: string | null
          trust_weight?: number
          verified_at?: string
          verified_by?: string
          verified_fields?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "event_verifications_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "event_verifications_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "events_public"
            referencedColumns: ["id"]
          },
        ]
      }
      events: {
        Row: {
          accessibility: string[] | null
          age_restriction: string | null
          confidence_breakdown: Json | null
          confidence_score: number
          contact: string | null
          content_type: string
          created_at: string
          date_end: string | null
          date_raw: string | null
          date_start: string | null
          date_type: string
          description: string | null
          embedding: string | null
          embedding_attempt_count: number
          embedding_attempted_at: string | null
          embedding_status: string | null
          enrichment_attempt_count: number
          enrichment_attempted_at: string | null
          enrichment_status: string | null
          event_category: string | null
          event_url: string | null
          event_url_checked_at: string | null
          event_url_status: string | null
          expires_at: string | null
          first_sighted_at: string
          flyer_style: string | null
          has_enrichment: boolean
          id: string
          is_active: boolean
          is_free: boolean | null
          is_outdoor: boolean | null
          is_public: boolean | null
          language: string | null
          last_sighted_at: string
          location_address: string | null
          location_geo: unknown
          location_name: string | null
          masks_required: string | null
          merge_match_type: string | null
          merged_at: string | null
          merged_into_id: string | null
          name: string
          organization_id: string | null
          price_raw: string | null
          recurrence_rule: string | null
          rsvp_required: boolean | null
          rsvp_url: string | null
          rsvp_url_checked_at: string | null
          rsvp_url_status: string | null
          search_text: string | null
          sighting_count: number
          staleness_days: number | null
          tags: string[] | null
          time_end: string | null
          time_start: string | null
          updated_at: string
          venue_id: string | null
        }
        Insert: {
          accessibility?: string[] | null
          age_restriction?: string | null
          confidence_breakdown?: Json | null
          confidence_score?: number
          contact?: string | null
          content_type?: string
          created_at?: string
          date_end?: string | null
          date_raw?: string | null
          date_start?: string | null
          date_type?: string
          description?: string | null
          embedding?: string | null
          embedding_attempt_count?: number
          embedding_attempted_at?: string | null
          embedding_status?: string | null
          enrichment_attempt_count?: number
          enrichment_attempted_at?: string | null
          enrichment_status?: string | null
          event_category?: string | null
          event_url?: string | null
          event_url_checked_at?: string | null
          event_url_status?: string | null
          expires_at?: string | null
          first_sighted_at?: string
          flyer_style?: string | null
          has_enrichment?: boolean
          id?: string
          is_active?: boolean
          is_free?: boolean | null
          is_outdoor?: boolean | null
          is_public?: boolean | null
          language?: string | null
          last_sighted_at?: string
          location_address?: string | null
          location_geo?: unknown
          location_name?: string | null
          masks_required?: string | null
          merge_match_type?: string | null
          merged_at?: string | null
          merged_into_id?: string | null
          name: string
          organization_id?: string | null
          price_raw?: string | null
          recurrence_rule?: string | null
          rsvp_required?: boolean | null
          rsvp_url?: string | null
          rsvp_url_checked_at?: string | null
          rsvp_url_status?: string | null
          search_text?: string | null
          sighting_count?: number
          staleness_days?: number | null
          tags?: string[] | null
          time_end?: string | null
          time_start?: string | null
          updated_at?: string
          venue_id?: string | null
        }
        Update: {
          accessibility?: string[] | null
          age_restriction?: string | null
          confidence_breakdown?: Json | null
          confidence_score?: number
          contact?: string | null
          content_type?: string
          created_at?: string
          date_end?: string | null
          date_raw?: string | null
          date_start?: string | null
          date_type?: string
          description?: string | null
          embedding?: string | null
          embedding_attempt_count?: number
          embedding_attempted_at?: string | null
          embedding_status?: string | null
          enrichment_attempt_count?: number
          enrichment_attempted_at?: string | null
          enrichment_status?: string | null
          event_category?: string | null
          event_url?: string | null
          event_url_checked_at?: string | null
          event_url_status?: string | null
          expires_at?: string | null
          first_sighted_at?: string
          flyer_style?: string | null
          has_enrichment?: boolean
          id?: string
          is_active?: boolean
          is_free?: boolean | null
          is_outdoor?: boolean | null
          is_public?: boolean | null
          language?: string | null
          last_sighted_at?: string
          location_address?: string | null
          location_geo?: unknown
          location_name?: string | null
          masks_required?: string | null
          merge_match_type?: string | null
          merged_at?: string | null
          merged_into_id?: string | null
          name?: string
          organization_id?: string | null
          price_raw?: string | null
          recurrence_rule?: string | null
          rsvp_required?: boolean | null
          rsvp_url?: string | null
          rsvp_url_checked_at?: string | null
          rsvp_url_status?: string | null
          search_text?: string | null
          sighting_count?: number
          staleness_days?: number | null
          tags?: string[] | null
          time_end?: string | null
          time_start?: string | null
          updated_at?: string
          venue_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "events_merged_into_id_fkey"
            columns: ["merged_into_id"]
            isOneToOne: false
            referencedRelation: "events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "events_merged_into_id_fkey"
            columns: ["merged_into_id"]
            isOneToOne: false
            referencedRelation: "events_public"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "events_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "events_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "events_public"
            referencedColumns: ["venue_id"]
          },
          {
            foreignKeyName: "events_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "events_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues_public"
            referencedColumns: ["id"]
          },
        ]
      }
      follows: {
        Row: {
          created_at: string
          id: string
          org_id: string | null
          talent_id: string | null
          user_id: string
          venue_id: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          org_id?: string | null
          talent_id?: string | null
          user_id: string
          venue_id?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          org_id?: string | null
          talent_id?: string | null
          user_id?: string
          venue_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "follows_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "follows_talent_id_fkey"
            columns: ["talent_id"]
            isOneToOne: false
            referencedRelation: "talent"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "follows_talent_id_fkey"
            columns: ["talent_id"]
            isOneToOne: false
            referencedRelation: "talent_public"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "follows_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "follows_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "events_public"
            referencedColumns: ["venue_id"]
          },
          {
            foreignKeyName: "follows_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "follows_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues_public"
            referencedColumns: ["id"]
          },
        ]
      }
      organizations: {
        Row: {
          canonical_name: string
          created_at: string
          description: string | null
          email: string | null
          first_seen_at: string
          id: string
          last_active_at: string | null
          name: string
          phone: string | null
          website: string | null
        }
        Insert: {
          canonical_name: string
          created_at?: string
          description?: string | null
          email?: string | null
          first_seen_at?: string
          id?: string
          last_active_at?: string | null
          name: string
          phone?: string | null
          website?: string | null
        }
        Update: {
          canonical_name?: string
          created_at?: string
          description?: string | null
          email?: string | null
          first_seen_at?: string
          id?: string
          last_active_at?: string | null
          name?: string
          phone?: string | null
          website?: string | null
        }
        Relationships: []
      }
      photos: {
        Row: {
          board_id: string | null
          captured_at: string | null
          created_at: string
          delete_after: string
          extracted_at: string | null
          extraction_error: string | null
          extraction_status: string
          id: string
          image_deleted_at: string | null
          image_url: string | null
          previous_photo_id: string | null
          processing_started_at: string | null
          submitted_at: string
          submitted_by: string | null
        }
        Insert: {
          board_id?: string | null
          captured_at?: string | null
          created_at?: string
          delete_after: string
          extracted_at?: string | null
          extraction_error?: string | null
          extraction_status?: string
          id?: string
          image_deleted_at?: string | null
          image_url?: string | null
          previous_photo_id?: string | null
          processing_started_at?: string | null
          submitted_at?: string
          submitted_by?: string | null
        }
        Update: {
          board_id?: string | null
          captured_at?: string | null
          created_at?: string
          delete_after?: string
          extracted_at?: string | null
          extraction_error?: string | null
          extraction_status?: string
          id?: string
          image_deleted_at?: string | null
          image_url?: string | null
          previous_photo_id?: string | null
          processing_started_at?: string | null
          submitted_at?: string
          submitted_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "photos_board_id_fkey"
            columns: ["board_id"]
            isOneToOne: false
            referencedRelation: "boards"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "photos_board_id_fkey"
            columns: ["board_id"]
            isOneToOne: false
            referencedRelation: "boards_public"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "photos_board_id_fkey"
            columns: ["board_id"]
            isOneToOne: false
            referencedRelation: "event_board_locations"
            referencedColumns: ["board_id"]
          },
          {
            foreignKeyName: "photos_previous_photo_id_fkey"
            columns: ["previous_photo_id"]
            isOneToOne: false
            referencedRelation: "photos"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "photos_submitted_by_fkey"
            columns: ["submitted_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      spatial_ref_sys: {
        Row: {
          auth_name: string | null
          auth_srid: number | null
          proj4text: string | null
          srid: number
          srtext: string | null
        }
        Insert: {
          auth_name?: string | null
          auth_srid?: number | null
          proj4text?: string | null
          srid: number
          srtext?: string | null
        }
        Update: {
          auth_name?: string | null
          auth_srid?: number | null
          proj4text?: string | null
          srid?: number
          srtext?: string | null
        }
        Relationships: []
      }
      talent: {
        Row: {
          canonical_name: string
          created_at: string
          description: string | null
          first_seen_at: string
          id: string
          is_active: boolean
          last_active_at: string | null
          merge_match_type: string | null
          merged_at: string | null
          merged_into_id: string | null
          name: string
          talent_type: string | null
          website: string | null
        }
        Insert: {
          canonical_name: string
          created_at?: string
          description?: string | null
          first_seen_at?: string
          id?: string
          is_active?: boolean
          last_active_at?: string | null
          merge_match_type?: string | null
          merged_at?: string | null
          merged_into_id?: string | null
          name: string
          talent_type?: string | null
          website?: string | null
        }
        Update: {
          canonical_name?: string
          created_at?: string
          description?: string | null
          first_seen_at?: string
          id?: string
          is_active?: boolean
          last_active_at?: string | null
          merge_match_type?: string | null
          merged_at?: string | null
          merged_into_id?: string | null
          name?: string
          talent_type?: string | null
          website?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "talent_merged_into_id_fkey"
            columns: ["merged_into_id"]
            isOneToOne: false
            referencedRelation: "talent"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "talent_merged_into_id_fkey"
            columns: ["merged_into_id"]
            isOneToOne: false
            referencedRelation: "talent_public"
            referencedColumns: ["id"]
          },
        ]
      }
      talent_name_reviews: {
        Row: {
          candidate_name: string
          evidence_url: string | null
          first_flagged_at: string
          flag_detail: string | null
          flag_reason: string
          id: string
          last_flagged_at: string
          name_key: string
          reasoning: string | null
          resolved_at: string | null
          resolved_by: string | null
          split_suggestion_a: string | null
          split_suggestion_b: string | null
          status: string
          talent_id: string | null
          used_web_search: boolean | null
          verdict_confidence: string | null
        }
        Insert: {
          candidate_name: string
          evidence_url?: string | null
          first_flagged_at?: string
          flag_detail?: string | null
          flag_reason: string
          id?: string
          last_flagged_at?: string
          name_key: string
          reasoning?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          split_suggestion_a?: string | null
          split_suggestion_b?: string | null
          status?: string
          talent_id?: string | null
          used_web_search?: boolean | null
          verdict_confidence?: string | null
        }
        Update: {
          candidate_name?: string
          evidence_url?: string | null
          first_flagged_at?: string
          flag_detail?: string | null
          flag_reason?: string
          id?: string
          last_flagged_at?: string
          name_key?: string
          reasoning?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          split_suggestion_a?: string | null
          split_suggestion_b?: string | null
          status?: string
          talent_id?: string | null
          used_web_search?: boolean | null
          verdict_confidence?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "talent_name_reviews_talent_id_fkey"
            columns: ["talent_id"]
            isOneToOne: false
            referencedRelation: "talent"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "talent_name_reviews_talent_id_fkey"
            columns: ["talent_id"]
            isOneToOne: false
            referencedRelation: "talent_public"
            referencedColumns: ["id"]
          },
        ]
      }
      users: {
        Row: {
          created_at: string
          email: string
          id: string
          is_active: boolean
          last_active_at: string | null
        }
        Insert: {
          created_at?: string
          email: string
          id: string
          is_active?: boolean
          last_active_at?: string | null
        }
        Update: {
          created_at?: string
          email?: string
          id?: string
          is_active?: boolean
          last_active_at?: string | null
        }
        Relationships: []
      }
      venues: {
        Row: {
          accessibility: string[] | null
          address: string | null
          canonical_name: string
          created_at: string
          description: string | null
          first_seen_at: string
          geolocation: unknown
          id: string
          is_active: boolean
          last_active_at: string | null
          name: string
          venue_type: string | null
          website: string | null
        }
        Insert: {
          accessibility?: string[] | null
          address?: string | null
          canonical_name: string
          created_at?: string
          description?: string | null
          first_seen_at?: string
          geolocation?: unknown
          id?: string
          is_active?: boolean
          last_active_at?: string | null
          name: string
          venue_type?: string | null
          website?: string | null
        }
        Update: {
          accessibility?: string[] | null
          address?: string | null
          canonical_name?: string
          created_at?: string
          description?: string | null
          first_seen_at?: string
          geolocation?: unknown
          id?: string
          is_active?: boolean
          last_active_at?: string | null
          name?: string
          venue_type?: string | null
          website?: string | null
        }
        Relationships: []
      }
    }
    Views: {
      boards_public: {
        Row: {
          active_flyer_count: number | null
          allowed_content_types: string[] | null
          content_mix: string[] | null
          description: string | null
          first_sighted_at: string | null
          geolocation: unknown
          id: string | null
          last_sighted_at: string | null
          location_name: string | null
          managed_by: string | null
          posting_policy: string | null
          requires_entry_to_photograph: boolean | null
          requires_entry_to_post: boolean | null
          total_flyer_count: number | null
        }
        Relationships: []
      }
      event_board_locations: {
        Row: {
          board_description: string | null
          board_id: string | null
          event_id: string | null
          first_seen_at: string | null
          geolocation: unknown
          last_seen_at: string | null
          lat: number | null
          lng: number | null
          location_name: string | null
          managed_by: string | null
          requires_entry_to_photograph: boolean | null
        }
        Relationships: [
          {
            foreignKeyName: "board_flyers_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "board_flyers_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "events_public"
            referencedColumns: ["id"]
          },
        ]
      }
      events_public: {
        Row: {
          accessibility: string[] | null
          age_restriction: string | null
          confidence_breakdown: Json | null
          confidence_score: number | null
          contact: string | null
          content_type: string | null
          date_end: string | null
          date_raw: string | null
          date_start: string | null
          date_type: string | null
          description: string | null
          event_category: string | null
          event_url: string | null
          event_url_status: string | null
          first_sighted_at: string | null
          flyer_style: string | null
          has_enrichment: boolean | null
          id: string | null
          is_free: boolean | null
          is_outdoor: boolean | null
          is_public: boolean | null
          language: string | null
          last_sighted_at: string | null
          location_address: string | null
          location_geo: unknown
          location_name: string | null
          masks_required: string | null
          name: string | null
          organization_name: string | null
          organization_website: string | null
          price_raw: string | null
          recurrence_rule: string | null
          rsvp_required: boolean | null
          rsvp_url: string | null
          rsvp_url_status: string | null
          search_text: string | null
          sighting_count: number | null
          tags: string[] | null
          talent: Json | null
          time_end: string | null
          time_start: string | null
          venue_accessibility: string[] | null
          venue_address: string | null
          venue_geo: unknown
          venue_id: string | null
          venue_name: string | null
          venue_website: string | null
        }
        Relationships: []
      }
      geography_columns: {
        Row: {
          coord_dimension: number | null
          f_geography_column: unknown
          f_table_catalog: unknown
          f_table_name: unknown
          f_table_schema: unknown
          srid: number | null
          type: string | null
        }
        Relationships: []
      }
      geometry_columns: {
        Row: {
          coord_dimension: number | null
          f_geometry_column: unknown
          f_table_catalog: string | null
          f_table_name: unknown
          f_table_schema: unknown
          srid: number | null
          type: string | null
        }
        Insert: {
          coord_dimension?: number | null
          f_geometry_column?: unknown
          f_table_catalog?: string | null
          f_table_name?: unknown
          f_table_schema?: unknown
          srid?: number | null
          type?: string | null
        }
        Update: {
          coord_dimension?: number | null
          f_geometry_column?: unknown
          f_table_catalog?: string | null
          f_table_name?: unknown
          f_table_schema?: unknown
          srid?: number | null
          type?: string | null
        }
        Relationships: []
      }
      talent_public: {
        Row: {
          description: string | null
          first_seen_at: string | null
          follower_count: number | null
          id: string | null
          last_active_at: string | null
          name: string | null
          next_event_date: string | null
          recent_venues: string[] | null
          upcoming_event_count: number | null
          website: string | null
        }
        Relationships: []
      }
      venues_public: {
        Row: {
          address: string | null
          description: string | null
          first_seen_at: string | null
          geolocation: unknown
          id: string | null
          last_active_at: string | null
          name: string | null
          next_event_date: string | null
          recent_talent: string[] | null
          upcoming_event_count: number | null
          venue_type: string | null
          website: string | null
        }
        Relationships: []
      }
    }
    Functions: {
      _postgis_deprecate: {
        Args: { newname: string; oldname: string; version: string }
        Returns: undefined
      }
      _postgis_index_extent: {
        Args: { col: string; tbl: unknown }
        Returns: unknown
      }
      _postgis_pgsql_version: { Args: never; Returns: string }
      _postgis_scripts_pgsql_version: { Args: never; Returns: string }
      _postgis_selectivity: {
        Args: { att_name: string; geom: unknown; mode?: string; tbl: unknown }
        Returns: number
      }
      _postgis_stats: {
        Args: { ""?: string; att_name: string; tbl: unknown }
        Returns: string
      }
      _st_3dintersects: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      _st_contains: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      _st_containsproperly: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      _st_coveredby:
        | { Args: { geog1: unknown; geog2: unknown }; Returns: boolean }
        | { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      _st_covers:
        | { Args: { geog1: unknown; geog2: unknown }; Returns: boolean }
        | { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      _st_crosses: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      _st_dwithin: {
        Args: {
          geog1: unknown
          geog2: unknown
          tolerance: number
          use_spheroid?: boolean
        }
        Returns: boolean
      }
      _st_equals: { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      _st_intersects: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      _st_linecrossingdirection: {
        Args: { line1: unknown; line2: unknown }
        Returns: number
      }
      _st_longestline: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      _st_maxdistance: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: number
      }
      _st_orderingequals: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      _st_overlaps: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      _st_sortablehash: { Args: { geom: unknown }; Returns: number }
      _st_touches: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      _st_voronoi: {
        Args: {
          clip?: unknown
          g1: unknown
          return_polygons?: boolean
          tolerance?: number
        }
        Returns: unknown
      }
      _st_within: { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      addauth: { Args: { "": string }; Returns: boolean }
      addgeometrycolumn:
        | {
            Args: {
              catalog_name: string
              column_name: string
              new_dim: number
              new_srid_in: number
              new_type: string
              schema_name: string
              table_name: string
              use_typmod?: boolean
            }
            Returns: string
          }
        | {
            Args: {
              column_name: string
              new_dim: number
              new_srid: number
              new_type: string
              schema_name: string
              table_name: string
              use_typmod?: boolean
            }
            Returns: string
          }
        | {
            Args: {
              column_name: string
              new_dim: number
              new_srid: number
              new_type: string
              table_name: string
              use_typmod?: boolean
            }
            Returns: string
          }
      apply_board_submission: {
        Args: { p_board_id: string }
        Returns: undefined
      }
      available_areas: {
        Args: never
        Returns: {
          board_count: number
          geo_city: string
          geo_neighborhood: string
          geo_region: string
          lat: number
          lng: number
        }[]
      }
      available_cities: {
        Args: never
        Returns: {
          board_count: number
          geo_city: string
          geo_region: string
          lat: number
          lng: number
        }[]
      }
      board_lat_lng: {
        Args: { p_board_id: string }
        Returns: {
          lat: number
          lng: number
        }[]
      }
      boards_near: {
        Args: { lat: number; lng: number; radius_m?: number }
        Returns: {
          distance_m: number
          geo_city: string
          geo_country: string
          geo_region: string
          id: string
        }[]
      }
      boards_near_detail: {
        Args: { lat: number; lng: number; radius_m?: number }
        Returns: {
          active_flyer_count: number
          board_lat: number
          board_lng: number
          description: string
          distance_m: number
          id: string
          last_sighted_at: string
          location_name: string
          managed_by: string
          popular_tags: string[]
          primary_category: string
          relevance_score: number
          requires_entry_to_photograph: boolean
          requires_entry_to_post: boolean
        }[]
      }
      claim_pending_photos: {
        Args: never
        Returns: {
          id: string
        }[]
      }
      cluster_event_name_buckets: {
        Args: { p_connect_similarity?: number; p_event_id: string }
        Returns: {
          component_id: string
          sample_value: string
          sighting_count: number
          sighting_ids: string[]
          total_weight: number
        }[]
      }
      compute_event_confidence: {
        Args: { p_event_id: string }
        Returns: number
      }
      confirm_talent_from_sighting: {
        Args: { p_event_id: string; p_incoming_talent_names: string[] }
        Returns: number
      }
      disablelongtransactions: { Args: never; Returns: string }
      dropgeometrycolumn:
        | {
            Args: {
              catalog_name: string
              column_name: string
              schema_name: string
              table_name: string
            }
            Returns: string
          }
        | {
            Args: {
              column_name: string
              schema_name: string
              table_name: string
            }
            Returns: string
          }
        | { Args: { column_name: string; table_name: string }; Returns: string }
      dropgeometrytable:
        | {
            Args: {
              catalog_name: string
              schema_name: string
              table_name: string
            }
            Returns: string
          }
        | { Args: { schema_name: string; table_name: string }; Returns: string }
        | { Args: { table_name: string }; Returns: string }
      enablelongtransactions: { Args: never; Returns: string }
      equals: { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      event_components_share_date: {
        Args: {
          p_connect_similarity?: number
          p_event_id: string
          p_min_component_sightings?: number
        }
        Returns: boolean
      }
      event_components_share_location: {
        Args: {
          p_connect_similarity?: number
          p_event_id: string
          p_min_component_sightings?: number
        }
        Returns: boolean
      }
      event_components_share_talent: {
        Args: {
          p_connect_similarity?: number
          p_event_id: string
          p_min_component_sightings?: number
        }
        Returns: boolean
      }
      event_date_type_priority: {
        Args: { p_date_type: string }
        Returns: number
      }
      event_is_stale: {
        Args: {
          p_date_type: string
          p_last_sighted_at: string
          p_staleness_days?: number
        }
        Returns: boolean
      }
      event_name_similarity: {
        Args: { p_a: string; p_b: string }
        Returns: number
      }
      events_for_boards: {
        Args: { board_ids: string[] }
        Returns: {
          accessibility: string[] | null
          age_restriction: string | null
          confidence_breakdown: Json | null
          confidence_score: number | null
          contact: string | null
          content_type: string | null
          date_end: string | null
          date_raw: string | null
          date_start: string | null
          date_type: string | null
          description: string | null
          event_category: string | null
          event_url: string | null
          event_url_status: string | null
          first_sighted_at: string | null
          flyer_style: string | null
          has_enrichment: boolean | null
          id: string | null
          is_free: boolean | null
          is_outdoor: boolean | null
          is_public: boolean | null
          language: string | null
          last_sighted_at: string | null
          location_address: string | null
          location_geo: unknown
          location_name: string | null
          masks_required: string | null
          name: string | null
          organization_name: string | null
          organization_website: string | null
          price_raw: string | null
          recurrence_rule: string | null
          rsvp_required: boolean | null
          rsvp_url: string | null
          rsvp_url_status: string | null
          search_text: string | null
          sighting_count: number | null
          tags: string[] | null
          talent: Json | null
          time_end: string | null
          time_start: string | null
          venue_accessibility: string[] | null
          venue_address: string | null
          venue_geo: unknown
          venue_id: string | null
          venue_name: string | null
          venue_website: string | null
        }[]
        SetofOptions: {
          from: "*"
          to: "events_public"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      find_event_match:
        | {
            Args: {
              p_board_lat: number
              p_board_lng: number
              p_date_start: string
              p_event_url: string
              p_location_name: string
              p_name: string
              p_talent_name?: string
            }
            Returns: Database["public"]["CompositeTypes"]["event_match_result"]
            SetofOptions: {
              from: "*"
              to: "event_match_result"
              isOneToOne: true
              isSetofReturn: false
            }
          }
        | {
            Args: {
              p_board_lat: number
              p_board_lng: number
              p_date_confidence?: number
              p_date_start: string
              p_event_url: string
              p_location_name: string
              p_name: string
              p_talent_name?: string
            }
            Returns: Database["public"]["CompositeTypes"]["event_match_result"]
            SetofOptions: {
              from: "*"
              to: "event_match_result"
              isOneToOne: true
              isSetofReturn: false
            }
          }
      find_nearby_board: {
        Args: { p_lat: number; p_lng: number; p_radius_meters?: number }
        Returns: {
          id: string
        }[]
      }
      generate_search_text: { Args: { p_event_id: string }; Returns: string }
      geometry: { Args: { "": string }; Returns: unknown }
      geometry_above: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_below: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_cmp: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: number
      }
      geometry_contained_3d: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_contains: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_contains_3d: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_distance_box: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: number
      }
      geometry_distance_centroid: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: number
      }
      geometry_eq: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_ge: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_gt: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_le: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_left: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_lt: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_overabove: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_overbelow: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_overlaps: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_overlaps_3d: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_overleft: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_overright: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_right: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_same: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_same_3d: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_within: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geomfromewkt: { Args: { "": string }; Returns: unknown }
      gettransactionid: { Args: never; Returns: unknown }
      longtransactionsenabled: { Args: never; Returns: boolean }
      mark_embedding_attempted: {
        Args: { p_event_id: string }
        Returns: undefined
      }
      mark_enrichment_attempted: {
        Args: { p_event_id: string }
        Returns: undefined
      }
      maybe_reenqueue_enrichment: {
        Args: {
          p_event_id: string
          p_new_date_start?: string
          p_new_description?: string
          p_new_event_url?: string
          p_new_location?: string
        }
        Returns: boolean
      }
      merge_events:
        | {
            Args: { p_canonical_id: string; p_duplicate_id: string }
            Returns: undefined
          }
        | {
            Args: {
              p_canonical_id: string
              p_duplicate_id: string
              p_match_type?: string
            }
            Returns: undefined
          }
      merge_talent: {
        Args: {
          p_canonical_id: string
          p_duplicate_id: string
          p_match_type?: string
        }
        Returns: undefined
      }
      normalize_event_name: { Args: { p_name: string }; Returns: string }
      normalize_location_name: { Args: { p_location: string }; Returns: string }
      populate_geometry_columns:
        | { Args: { tbl_oid: unknown; use_typmod?: boolean }; Returns: number }
        | { Args: { use_typmod?: boolean }; Returns: string }
      postgis_constraint_dims: {
        Args: { geomcolumn: string; geomschema: string; geomtable: string }
        Returns: number
      }
      postgis_constraint_srid: {
        Args: { geomcolumn: string; geomschema: string; geomtable: string }
        Returns: number
      }
      postgis_constraint_type: {
        Args: { geomcolumn: string; geomschema: string; geomtable: string }
        Returns: string
      }
      postgis_extensions_upgrade: { Args: never; Returns: string }
      postgis_full_version: { Args: never; Returns: string }
      postgis_geos_version: { Args: never; Returns: string }
      postgis_lib_build_date: { Args: never; Returns: string }
      postgis_lib_revision: { Args: never; Returns: string }
      postgis_lib_version: { Args: never; Returns: string }
      postgis_libjson_version: { Args: never; Returns: string }
      postgis_liblwgeom_version: { Args: never; Returns: string }
      postgis_libprotobuf_version: { Args: never; Returns: string }
      postgis_libxml_version: { Args: never; Returns: string }
      postgis_proj_version: { Args: never; Returns: string }
      postgis_scripts_build_date: { Args: never; Returns: string }
      postgis_scripts_installed: { Args: never; Returns: string }
      postgis_scripts_released: { Args: never; Returns: string }
      postgis_svn_version: { Args: never; Returns: string }
      postgis_type_name: {
        Args: {
          coord_dimension: number
          geomname: string
          use_new_name?: boolean
        }
        Returns: string
      }
      postgis_version: { Args: never; Returns: string }
      postgis_wagyu_version: { Args: never; Returns: string }
      reap_stale_processing_photos: { Args: never; Returns: number }
      reconstruct_talent_from_sightings: {
        Args: { p_dry_run?: boolean }
        Returns: {
          change_type: string
          detail: string
          talent_id: string
          talent_name: string
        }[]
      }
      run_dedup_pass: {
        Args: { p_dry_run?: boolean }
        Returns: {
          canonical_id: string
          canonical_name: string
          date_type_mismatch: boolean
          duplicate_id: string
          duplicate_name: string
          match_type: string
        }[]
      }
      run_field_reconciliation_pass: {
        Args: { p_dry_run?: boolean }
        Returns: {
          auto_split: boolean
          date_overlap_detected: boolean
          event_id: string
          field: string
          flagged: boolean
          location_overlap_detected: boolean
          new_value: string
          old_value: string
          runner_up_sightings: number
          runner_up_value: string
          talent_overlap_detected: boolean
          total_sightings: number
          vote_share: number
          winning_sightings: number
        }[]
      }
      run_talent_dedup_pass: {
        Args: { p_run_name_similarity?: boolean; p_run_same_event?: boolean }
        Returns: {
          canonical_id: string
          canonical_name: string
          duplicate_id: string
          duplicate_name: string
          flagged: boolean
          match_type: string
          merged: boolean
        }[]
      }
      search_events_semantic: {
        Args: {
          match_count?: number
          match_threshold?: number
          query_embedding: string
        }
        Returns: {
          accessibility: string[] | null
          age_restriction: string | null
          confidence_breakdown: Json | null
          confidence_score: number | null
          contact: string | null
          content_type: string | null
          date_end: string | null
          date_raw: string | null
          date_start: string | null
          date_type: string | null
          description: string | null
          event_category: string | null
          event_url: string | null
          event_url_status: string | null
          first_sighted_at: string | null
          flyer_style: string | null
          has_enrichment: boolean | null
          id: string | null
          is_free: boolean | null
          is_outdoor: boolean | null
          is_public: boolean | null
          language: string | null
          last_sighted_at: string | null
          location_address: string | null
          location_geo: unknown
          location_name: string | null
          masks_required: string | null
          name: string | null
          organization_name: string | null
          organization_website: string | null
          price_raw: string | null
          recurrence_rule: string | null
          rsvp_required: boolean | null
          rsvp_url: string | null
          rsvp_url_status: string | null
          search_text: string | null
          sighting_count: number | null
          tags: string[] | null
          talent: Json | null
          time_end: string | null
          time_start: string | null
          venue_accessibility: string[] | null
          venue_address: string | null
          venue_geo: unknown
          venue_id: string | null
          venue_name: string | null
          venue_website: string | null
        }[]
        SetofOptions: {
          from: "*"
          to: "events_public"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      show_limit: { Args: never; Returns: number }
      show_trgm: { Args: { "": string }; Returns: string[] }
      split_event: {
        Args: {
          p_dry_run?: boolean
          p_event_id: string
          p_sighting_ids: string[]
        }
        Returns: {
          boards_affected: number
          new_event_id: string
          new_event_name: string
          old_event_boards_removed: number
          sightings_moved: number
          talent_moved: number
        }[]
      }
      st_3dclosestpoint: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_3ddistance: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: number
      }
      st_3dintersects: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      st_3dlongestline: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_3dmakebox: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_3dmaxdistance: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: number
      }
      st_3dshortestline: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_addpoint: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_angle:
        | { Args: { line1: unknown; line2: unknown }; Returns: number }
        | {
            Args: { pt1: unknown; pt2: unknown; pt3: unknown; pt4?: unknown }
            Returns: number
          }
      st_area:
        | { Args: { geog: unknown; use_spheroid?: boolean }; Returns: number }
        | { Args: { "": string }; Returns: number }
      st_asencodedpolyline: {
        Args: { geom: unknown; nprecision?: number }
        Returns: string
      }
      st_asewkt: { Args: { "": string }; Returns: string }
      st_asgeojson:
        | {
            Args: { geog: unknown; maxdecimaldigits?: number; options?: number }
            Returns: string
          }
        | {
            Args: { geom: unknown; maxdecimaldigits?: number; options?: number }
            Returns: string
          }
        | {
            Args: {
              geom_column?: string
              maxdecimaldigits?: number
              pretty_bool?: boolean
              r: Record<string, unknown>
            }
            Returns: string
          }
        | { Args: { "": string }; Returns: string }
      st_asgml:
        | {
            Args: {
              geog: unknown
              id?: string
              maxdecimaldigits?: number
              nprefix?: string
              options?: number
            }
            Returns: string
          }
        | {
            Args: { geom: unknown; maxdecimaldigits?: number; options?: number }
            Returns: string
          }
        | { Args: { "": string }; Returns: string }
        | {
            Args: {
              geog: unknown
              id?: string
              maxdecimaldigits?: number
              nprefix?: string
              options?: number
              version: number
            }
            Returns: string
          }
        | {
            Args: {
              geom: unknown
              id?: string
              maxdecimaldigits?: number
              nprefix?: string
              options?: number
              version: number
            }
            Returns: string
          }
      st_askml:
        | {
            Args: { geog: unknown; maxdecimaldigits?: number; nprefix?: string }
            Returns: string
          }
        | {
            Args: { geom: unknown; maxdecimaldigits?: number; nprefix?: string }
            Returns: string
          }
        | { Args: { "": string }; Returns: string }
      st_aslatlontext: {
        Args: { geom: unknown; tmpl?: string }
        Returns: string
      }
      st_asmarc21: { Args: { format?: string; geom: unknown }; Returns: string }
      st_asmvtgeom: {
        Args: {
          bounds: unknown
          buffer?: number
          clip_geom?: boolean
          extent?: number
          geom: unknown
        }
        Returns: unknown
      }
      st_assvg:
        | {
            Args: { geog: unknown; maxdecimaldigits?: number; rel?: number }
            Returns: string
          }
        | {
            Args: { geom: unknown; maxdecimaldigits?: number; rel?: number }
            Returns: string
          }
        | { Args: { "": string }; Returns: string }
      st_astext: { Args: { "": string }; Returns: string }
      st_astwkb:
        | {
            Args: {
              geom: unknown
              prec?: number
              prec_m?: number
              prec_z?: number
              with_boxes?: boolean
              with_sizes?: boolean
            }
            Returns: string
          }
        | {
            Args: {
              geom: unknown[]
              ids: number[]
              prec?: number
              prec_m?: number
              prec_z?: number
              with_boxes?: boolean
              with_sizes?: boolean
            }
            Returns: string
          }
      st_asx3d: {
        Args: { geom: unknown; maxdecimaldigits?: number; options?: number }
        Returns: string
      }
      st_azimuth:
        | { Args: { geog1: unknown; geog2: unknown }; Returns: number }
        | { Args: { geom1: unknown; geom2: unknown }; Returns: number }
      st_boundingdiagonal: {
        Args: { fits?: boolean; geom: unknown }
        Returns: unknown
      }
      st_buffer:
        | {
            Args: { geom: unknown; options?: string; radius: number }
            Returns: unknown
          }
        | {
            Args: { geom: unknown; quadsegs: number; radius: number }
            Returns: unknown
          }
      st_centroid: { Args: { "": string }; Returns: unknown }
      st_clipbybox2d: {
        Args: { box: unknown; geom: unknown }
        Returns: unknown
      }
      st_closestpoint: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_collect: { Args: { geom1: unknown; geom2: unknown }; Returns: unknown }
      st_concavehull: {
        Args: {
          param_allow_holes?: boolean
          param_geom: unknown
          param_pctconvex: number
        }
        Returns: unknown
      }
      st_contains: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      st_containsproperly: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      st_coorddim: { Args: { geometry: unknown }; Returns: number }
      st_coveredby:
        | { Args: { geog1: unknown; geog2: unknown }; Returns: boolean }
        | { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      st_covers:
        | { Args: { geog1: unknown; geog2: unknown }; Returns: boolean }
        | { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      st_crosses: { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      st_curvetoline: {
        Args: { flags?: number; geom: unknown; tol?: number; toltype?: number }
        Returns: unknown
      }
      st_delaunaytriangles: {
        Args: { flags?: number; g1: unknown; tolerance?: number }
        Returns: unknown
      }
      st_difference: {
        Args: { geom1: unknown; geom2: unknown; gridsize?: number }
        Returns: unknown
      }
      st_disjoint: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      st_distance:
        | {
            Args: { geog1: unknown; geog2: unknown; use_spheroid?: boolean }
            Returns: number
          }
        | { Args: { geom1: unknown; geom2: unknown }; Returns: number }
      st_distancesphere:
        | { Args: { geom1: unknown; geom2: unknown }; Returns: number }
        | {
            Args: { geom1: unknown; geom2: unknown; radius: number }
            Returns: number
          }
      st_distancespheroid: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: number
      }
      st_dwithin: {
        Args: {
          geog1: unknown
          geog2: unknown
          tolerance: number
          use_spheroid?: boolean
        }
        Returns: boolean
      }
      st_equals: { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      st_expand:
        | { Args: { box: unknown; dx: number; dy: number }; Returns: unknown }
        | {
            Args: { box: unknown; dx: number; dy: number; dz?: number }
            Returns: unknown
          }
        | {
            Args: {
              dm?: number
              dx: number
              dy: number
              dz?: number
              geom: unknown
            }
            Returns: unknown
          }
      st_force3d: { Args: { geom: unknown; zvalue?: number }; Returns: unknown }
      st_force3dm: {
        Args: { geom: unknown; mvalue?: number }
        Returns: unknown
      }
      st_force3dz: {
        Args: { geom: unknown; zvalue?: number }
        Returns: unknown
      }
      st_force4d: {
        Args: { geom: unknown; mvalue?: number; zvalue?: number }
        Returns: unknown
      }
      st_generatepoints:
        | { Args: { area: unknown; npoints: number }; Returns: unknown }
        | {
            Args: { area: unknown; npoints: number; seed: number }
            Returns: unknown
          }
      st_geogfromtext: { Args: { "": string }; Returns: unknown }
      st_geographyfromtext: { Args: { "": string }; Returns: unknown }
      st_geohash:
        | { Args: { geog: unknown; maxchars?: number }; Returns: string }
        | { Args: { geom: unknown; maxchars?: number }; Returns: string }
      st_geomcollfromtext: { Args: { "": string }; Returns: unknown }
      st_geometricmedian: {
        Args: {
          fail_if_not_converged?: boolean
          g: unknown
          max_iter?: number
          tolerance?: number
        }
        Returns: unknown
      }
      st_geometryfromtext: { Args: { "": string }; Returns: unknown }
      st_geomfromewkt: { Args: { "": string }; Returns: unknown }
      st_geomfromgeojson:
        | { Args: { "": Json }; Returns: unknown }
        | { Args: { "": Json }; Returns: unknown }
        | { Args: { "": string }; Returns: unknown }
      st_geomfromgml: { Args: { "": string }; Returns: unknown }
      st_geomfromkml: { Args: { "": string }; Returns: unknown }
      st_geomfrommarc21: { Args: { marc21xml: string }; Returns: unknown }
      st_geomfromtext: { Args: { "": string }; Returns: unknown }
      st_gmltosql: { Args: { "": string }; Returns: unknown }
      st_hasarc: { Args: { geometry: unknown }; Returns: boolean }
      st_hausdorffdistance: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: number
      }
      st_hexagon: {
        Args: { cell_i: number; cell_j: number; origin?: unknown; size: number }
        Returns: unknown
      }
      st_hexagongrid: {
        Args: { bounds: unknown; size: number }
        Returns: Record<string, unknown>[]
      }
      st_interpolatepoint: {
        Args: { line: unknown; point: unknown }
        Returns: number
      }
      st_intersection: {
        Args: { geom1: unknown; geom2: unknown; gridsize?: number }
        Returns: unknown
      }
      st_intersects:
        | { Args: { geog1: unknown; geog2: unknown }; Returns: boolean }
        | { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      st_isvaliddetail: {
        Args: { flags?: number; geom: unknown }
        Returns: Database["public"]["CompositeTypes"]["valid_detail"]
        SetofOptions: {
          from: "*"
          to: "valid_detail"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      st_length:
        | { Args: { geog: unknown; use_spheroid?: boolean }; Returns: number }
        | { Args: { "": string }; Returns: number }
      st_letters: { Args: { font?: Json; letters: string }; Returns: unknown }
      st_linecrossingdirection: {
        Args: { line1: unknown; line2: unknown }
        Returns: number
      }
      st_linefromencodedpolyline: {
        Args: { nprecision?: number; txtin: string }
        Returns: unknown
      }
      st_linefromtext: { Args: { "": string }; Returns: unknown }
      st_linelocatepoint: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: number
      }
      st_linetocurve: { Args: { geometry: unknown }; Returns: unknown }
      st_locatealong: {
        Args: { geometry: unknown; leftrightoffset?: number; measure: number }
        Returns: unknown
      }
      st_locatebetween: {
        Args: {
          frommeasure: number
          geometry: unknown
          leftrightoffset?: number
          tomeasure: number
        }
        Returns: unknown
      }
      st_locatebetweenelevations: {
        Args: { fromelevation: number; geometry: unknown; toelevation: number }
        Returns: unknown
      }
      st_longestline: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_makebox2d: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_makeline: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_makevalid: {
        Args: { geom: unknown; params: string }
        Returns: unknown
      }
      st_maxdistance: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: number
      }
      st_minimumboundingcircle: {
        Args: { inputgeom: unknown; segs_per_quarter?: number }
        Returns: unknown
      }
      st_mlinefromtext: { Args: { "": string }; Returns: unknown }
      st_mpointfromtext: { Args: { "": string }; Returns: unknown }
      st_mpolyfromtext: { Args: { "": string }; Returns: unknown }
      st_multilinestringfromtext: { Args: { "": string }; Returns: unknown }
      st_multipointfromtext: { Args: { "": string }; Returns: unknown }
      st_multipolygonfromtext: { Args: { "": string }; Returns: unknown }
      st_node: { Args: { g: unknown }; Returns: unknown }
      st_normalize: { Args: { geom: unknown }; Returns: unknown }
      st_offsetcurve: {
        Args: { distance: number; line: unknown; params?: string }
        Returns: unknown
      }
      st_orderingequals: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      st_overlaps: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      st_perimeter: {
        Args: { geog: unknown; use_spheroid?: boolean }
        Returns: number
      }
      st_pointfromtext: { Args: { "": string }; Returns: unknown }
      st_pointm: {
        Args: {
          mcoordinate: number
          srid?: number
          xcoordinate: number
          ycoordinate: number
        }
        Returns: unknown
      }
      st_pointz: {
        Args: {
          srid?: number
          xcoordinate: number
          ycoordinate: number
          zcoordinate: number
        }
        Returns: unknown
      }
      st_pointzm: {
        Args: {
          mcoordinate: number
          srid?: number
          xcoordinate: number
          ycoordinate: number
          zcoordinate: number
        }
        Returns: unknown
      }
      st_polyfromtext: { Args: { "": string }; Returns: unknown }
      st_polygonfromtext: { Args: { "": string }; Returns: unknown }
      st_project: {
        Args: { azimuth: number; distance: number; geog: unknown }
        Returns: unknown
      }
      st_quantizecoordinates: {
        Args: {
          g: unknown
          prec_m?: number
          prec_x: number
          prec_y?: number
          prec_z?: number
        }
        Returns: unknown
      }
      st_reduceprecision: {
        Args: { geom: unknown; gridsize: number }
        Returns: unknown
      }
      st_relate: { Args: { geom1: unknown; geom2: unknown }; Returns: string }
      st_removerepeatedpoints: {
        Args: { geom: unknown; tolerance?: number }
        Returns: unknown
      }
      st_segmentize: {
        Args: { geog: unknown; max_segment_length: number }
        Returns: unknown
      }
      st_setsrid:
        | { Args: { geog: unknown; srid: number }; Returns: unknown }
        | { Args: { geom: unknown; srid: number }; Returns: unknown }
      st_sharedpaths: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_shortestline: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_simplifypolygonhull: {
        Args: { geom: unknown; is_outer?: boolean; vertex_fraction: number }
        Returns: unknown
      }
      st_split: { Args: { geom1: unknown; geom2: unknown }; Returns: unknown }
      st_square: {
        Args: { cell_i: number; cell_j: number; origin?: unknown; size: number }
        Returns: unknown
      }
      st_squaregrid: {
        Args: { bounds: unknown; size: number }
        Returns: Record<string, unknown>[]
      }
      st_srid:
        | { Args: { geog: unknown }; Returns: number }
        | { Args: { geom: unknown }; Returns: number }
      st_subdivide: {
        Args: { geom: unknown; gridsize?: number; maxvertices?: number }
        Returns: unknown[]
      }
      st_swapordinates: {
        Args: { geom: unknown; ords: unknown }
        Returns: unknown
      }
      st_symdifference: {
        Args: { geom1: unknown; geom2: unknown; gridsize?: number }
        Returns: unknown
      }
      st_symmetricdifference: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_tileenvelope: {
        Args: {
          bounds?: unknown
          margin?: number
          x: number
          y: number
          zoom: number
        }
        Returns: unknown
      }
      st_touches: { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      st_transform:
        | {
            Args: { from_proj: string; geom: unknown; to_proj: string }
            Returns: unknown
          }
        | {
            Args: { from_proj: string; geom: unknown; to_srid: number }
            Returns: unknown
          }
        | { Args: { geom: unknown; to_proj: string }; Returns: unknown }
      st_triangulatepolygon: { Args: { g1: unknown }; Returns: unknown }
      st_union:
        | { Args: { geom1: unknown; geom2: unknown }; Returns: unknown }
        | {
            Args: { geom1: unknown; geom2: unknown; gridsize: number }
            Returns: unknown
          }
      st_voronoilines: {
        Args: { extend_to?: unknown; g1: unknown; tolerance?: number }
        Returns: unknown
      }
      st_voronoipolygons: {
        Args: { extend_to?: unknown; g1: unknown; tolerance?: number }
        Returns: unknown
      }
      st_within: { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      st_wkbtosql: { Args: { wkb: string }; Returns: unknown }
      st_wkttosql: { Args: { "": string }; Returns: unknown }
      st_wrapx: {
        Args: { geom: unknown; move: number; wrap: number }
        Returns: unknown
      }
      unlockrows: { Args: { "": string }; Returns: number }
      updategeometrysrid: {
        Args: {
          catalogn_name: string
          column_name: string
          new_srid_in: number
          schema_name: string
          table_name: string
        }
        Returns: string
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      event_match_result: {
        match_id: string | null
        match_type: string | null
      }
      geometry_dump: {
        path: number[] | null
        geom: unknown
      }
      valid_detail: {
        valid: boolean | null
        reason: string | null
        location: unknown
      }
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {},
  },
} as const
