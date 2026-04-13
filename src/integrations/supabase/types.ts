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
    PostgrestVersion: "14.1"
  }
  public: {
    Tables: {
      audit_logs: {
        Row: {
          action: string
          client_id: string | null
          created_at: string | null
          details: Json | null
          id: string
          user_id: string
        }
        Insert: {
          action: string
          client_id?: string | null
          created_at?: string | null
          details?: Json | null
          id?: string
          user_id: string
        }
        Update: {
          action?: string
          client_id?: string | null
          created_at?: string | null
          details?: Json | null
          id?: string
          user_id?: string
        }
        Relationships: []
      }
      bot_settings: {
        Row: {
          id: string
          setting_key: string
          setting_value: string
          updated_at: string
        }
        Insert: {
          id?: string
          setting_key: string
          setting_value: string
          updated_at?: string
        }
        Update: {
          id?: string
          setting_key?: string
          setting_value?: string
          updated_at?: string
        }
        Relationships: []
      }
      client_aliases: {
        Row: {
          alias: string
          client_id: string | null
          client_name: string | null
          created_at: string | null
          id: string
        }
        Insert: {
          alias: string
          client_id?: string | null
          client_name?: string | null
          created_at?: string | null
          id?: string
        }
        Update: {
          alias?: string
          client_id?: string | null
          client_name?: string | null
          created_at?: string | null
          id?: string
        }
        Relationships: [
          {
            foreignKeyName: "client_aliases_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
        ]
      }
      clients: {
        Row: {
          business_type: string | null
          client_pipeline: string
          created_at: string | null
          drive_folder_id: string | null
          email: string | null
          id: string
          name: string
          phone: string | null
        }
        Insert: {
          business_type?: string | null
          client_pipeline?: string
          created_at?: string | null
          drive_folder_id?: string | null
          email?: string | null
          id?: string
          name: string
          phone?: string | null
        }
        Update: {
          business_type?: string | null
          client_pipeline?: string
          created_at?: string | null
          drive_folder_id?: string | null
          email?: string | null
          id?: string
          name?: string
          phone?: string | null
        }
        Relationships: []
      }
      conflicts: {
        Row: {
          client_id: string
          created_at: string | null
          id: string
          object_key: string
          object_type: string
          observation_ids: Json
          reason: string
          resolved_at: string | null
          status: string
        }
        Insert: {
          client_id: string
          created_at?: string | null
          id?: string
          object_key: string
          object_type: string
          observation_ids: Json
          reason: string
          resolved_at?: string | null
          status?: string
        }
        Update: {
          client_id?: string
          created_at?: string | null
          id?: string
          object_key?: string
          object_type?: string
          observation_ids?: Json
          reason?: string
          resolved_at?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "conflicts_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
        ]
      }
      connected_projects: {
        Row: {
          created_at: string
          description: string | null
          id: string
          is_active: boolean
          name: string
          secret_key_name: string
          supabase_url: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          description?: string | null
          id?: string
          is_active?: boolean
          name: string
          secret_key_name: string
          supabase_url: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          description?: string | null
          id?: string
          is_active?: boolean
          name?: string
          secret_key_name?: string
          supabase_url?: string
          updated_at?: string
        }
        Relationships: []
      }
      credit_analyses: {
        Row: {
          analysis: Json
          client_id: string
          created_at: string | null
          id: string
          model: string | null
          updated_at: string | null
        }
        Insert: {
          analysis: Json
          client_id: string
          created_at?: string | null
          id?: string
          model?: string | null
          updated_at?: string | null
        }
        Update: {
          analysis?: Json
          client_id?: string
          created_at?: string | null
          id?: string
          model?: string | null
          updated_at?: string | null
        }
        Relationships: []
      }
      credit_knowledge_base: {
        Row: {
          case_type: string | null
          content: string
          created_at: string
          embedding: string | null
          id: string
          metadata: Json | null
          trigger: string | null
          type: string
        }
        Insert: {
          case_type?: string | null
          content: string
          created_at?: string
          embedding?: string | null
          id?: string
          metadata?: Json | null
          trigger?: string | null
          type: string
        }
        Update: {
          case_type?: string | null
          content?: string
          created_at?: string
          embedding?: string | null
          id?: string
          metadata?: Json | null
          trigger?: string | null
          type?: string
        }
        Relationships: []
      }
      dispute_letters: {
        Row: {
          account_name: string | null
          bureau: string
          client_id: string
          created_at: string | null
          dispute_reason: string | null
          id: string
          letter_content: string | null
          model: string | null
          status: string | null
          updated_at: string | null
        }
        Insert: {
          account_name?: string | null
          bureau: string
          client_id: string
          created_at?: string | null
          dispute_reason?: string | null
          id?: string
          letter_content?: string | null
          model?: string | null
          status?: string | null
          updated_at?: string | null
        }
        Update: {
          account_name?: string | null
          bureau?: string
          client_id?: string
          created_at?: string | null
          dispute_reason?: string | null
          id?: string
          letter_content?: string | null
          model?: string | null
          status?: string | null
          updated_at?: string | null
        }
        Relationships: []
      }
      documents: {
        Row: {
          bureau: string | null
          client_id: string
          conversion_status: string | null
          created_at: string | null
          doc_type: string | null
          drive_file_id: string | null
          drive_modified_time: string
          drive_parent_folder_id: string | null
          file_name: string
          gemini_file_expires_at: string | null
          gemini_file_uri: string | null
          id: string
          is_deleted: boolean
          mime_type: string
          original_mime_type: string
          processed_mime_type: string
          replaced_by_document_id: string | null
          report_date: string | null
          sha256: string
          source: string | null
          source_version: number
          status: string
          storage_object_path: string | null
          tax_year: number | null
          updated_at: string | null
        }
        Insert: {
          bureau?: string | null
          client_id: string
          conversion_status?: string | null
          created_at?: string | null
          doc_type?: string | null
          drive_file_id?: string | null
          drive_modified_time: string
          drive_parent_folder_id?: string | null
          file_name: string
          gemini_file_expires_at?: string | null
          gemini_file_uri?: string | null
          id?: string
          is_deleted?: boolean
          mime_type: string
          original_mime_type: string
          processed_mime_type?: string
          replaced_by_document_id?: string | null
          report_date?: string | null
          sha256: string
          source?: string | null
          source_version?: number
          status?: string
          storage_object_path?: string | null
          tax_year?: number | null
          updated_at?: string | null
        }
        Update: {
          bureau?: string | null
          client_id?: string
          conversion_status?: string | null
          created_at?: string | null
          doc_type?: string | null
          drive_file_id?: string | null
          drive_modified_time?: string
          drive_parent_folder_id?: string | null
          file_name?: string
          gemini_file_expires_at?: string | null
          gemini_file_uri?: string | null
          id?: string
          is_deleted?: boolean
          mime_type?: string
          original_mime_type?: string
          processed_mime_type?: string
          replaced_by_document_id?: string | null
          report_date?: string | null
          sha256?: string
          source?: string | null
          source_version?: number
          status?: string
          storage_object_path?: string | null
          tax_year?: number | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "documents_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "documents_replaced_by_document_id_fkey"
            columns: ["replaced_by_document_id"]
            isOneToOne: false
            referencedRelation: "documents"
            referencedColumns: ["id"]
          },
        ]
      }
      drive_sync_events: {
        Row: {
          attempt_count: number
          client_id: string | null
          created_at: string | null
          drive_file_id: string
          drive_modified_time: string
          event_type: string
          id: string
          is_deleted: boolean
          last_error: string | null
          previous_modified_time: string | null
          run_id: string
          status: string
        }
        Insert: {
          attempt_count?: number
          client_id?: string | null
          created_at?: string | null
          drive_file_id: string
          drive_modified_time: string
          event_type: string
          id?: string
          is_deleted?: boolean
          last_error?: string | null
          previous_modified_time?: string | null
          run_id: string
          status: string
        }
        Update: {
          attempt_count?: number
          client_id?: string | null
          created_at?: string | null
          drive_file_id?: string
          drive_modified_time?: string
          event_type?: string
          id?: string
          is_deleted?: boolean
          last_error?: string | null
          previous_modified_time?: string | null
          run_id?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "drive_sync_events_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "drive_sync_events_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "drive_sync_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      drive_sync_runs: {
        Row: {
          completed_at: string | null
          drive_new_page_token: string | null
          drive_start_page_token: string | null
          id: string
          last_error: string | null
          started_at: string | null
          status: string
        }
        Insert: {
          completed_at?: string | null
          drive_new_page_token?: string | null
          drive_start_page_token?: string | null
          id?: string
          last_error?: string | null
          started_at?: string | null
          status: string
        }
        Update: {
          completed_at?: string | null
          drive_new_page_token?: string | null
          drive_start_page_token?: string | null
          id?: string
          last_error?: string | null
          started_at?: string | null
          status?: string
        }
        Relationships: []
      }
      extracted_pages: {
        Row: {
          created_at: string | null
          document_id: string
          id: string
          ocr_confidence: number | null
          ocr_used: boolean
          page_number: number
          page_sha256: string | null
          text: string | null
        }
        Insert: {
          created_at?: string | null
          document_id: string
          id?: string
          ocr_confidence?: number | null
          ocr_used?: boolean
          page_number: number
          page_sha256?: string | null
          text?: string | null
        }
        Update: {
          created_at?: string | null
          document_id?: string
          id?: string
          ocr_confidence?: number | null
          ocr_used?: boolean
          page_number?: number
          page_sha256?: string | null
          text?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "extracted_pages_document_id_fkey"
            columns: ["document_id"]
            isOneToOne: false
            referencedRelation: "documents"
            referencedColumns: ["id"]
          },
        ]
      }
      ingestion_jobs: {
        Row: {
          attempt_count: number
          client_id: string | null
          completed_at: string | null
          created_at: string | null
          document_id: string | null
          drive_file_id: string | null
          heartbeat_at: string | null
          id: string
          job_type: string
          last_error: string | null
          started_at: string | null
          status: string
          updated_at: string | null
          worker_id: string | null
        }
        Insert: {
          attempt_count?: number
          client_id?: string | null
          completed_at?: string | null
          created_at?: string | null
          document_id?: string | null
          drive_file_id?: string | null
          heartbeat_at?: string | null
          id?: string
          job_type: string
          last_error?: string | null
          started_at?: string | null
          status: string
          updated_at?: string | null
          worker_id?: string | null
        }
        Update: {
          attempt_count?: number
          client_id?: string | null
          completed_at?: string | null
          created_at?: string | null
          document_id?: string | null
          drive_file_id?: string | null
          heartbeat_at?: string | null
          id?: string
          job_type?: string
          last_error?: string | null
          started_at?: string | null
          status?: string
          updated_at?: string | null
          worker_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ingestion_jobs_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ingestion_jobs_document_id_fkey"
            columns: ["document_id"]
            isOneToOne: false
            referencedRelation: "documents"
            referencedColumns: ["id"]
          },
        ]
      }
      marketing_spend: {
        Row: {
          ad_name: string | null
          ad_set_name: string | null
          campaign_id: string | null
          campaign_name: string | null
          clicks: number | null
          client_id: string | null
          conversions: number | null
          created_at: string
          currency: string
          date: string
          id: string
          impressions: number | null
          platform: string
          raw_data: Json | null
          spend: number
          updated_at: string
        }
        Insert: {
          ad_name?: string | null
          ad_set_name?: string | null
          campaign_id?: string | null
          campaign_name?: string | null
          clicks?: number | null
          client_id?: string | null
          conversions?: number | null
          created_at?: string
          currency?: string
          date: string
          id?: string
          impressions?: number | null
          platform?: string
          raw_data?: Json | null
          spend?: number
          updated_at?: string
        }
        Update: {
          ad_name?: string | null
          ad_set_name?: string | null
          campaign_id?: string | null
          campaign_name?: string | null
          clicks?: number | null
          client_id?: string | null
          conversions?: number | null
          created_at?: string
          currency?: string
          date?: string
          id?: string
          impressions?: number | null
          platform?: string
          raw_data?: Json | null
          spend?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "marketing_spend_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
        ]
      }
      observations: {
        Row: {
          bbox_json: Json | null
          client_id: string
          confidence: number
          created_at: string | null
          document_id: string
          evidence_page_range: string | null
          evidence_snippet: string | null
          field_name: string
          field_value_json: Json | null
          field_value_text: string | null
          id: string
          is_verified: boolean
          model_id: string
          object_key: string
          object_type: string
          page_number: number | null
          verified_at: string | null
          verified_via: string | null
        }
        Insert: {
          bbox_json?: Json | null
          client_id: string
          confidence: number
          created_at?: string | null
          document_id: string
          evidence_page_range?: string | null
          evidence_snippet?: string | null
          field_name: string
          field_value_json?: Json | null
          field_value_text?: string | null
          id?: string
          is_verified?: boolean
          model_id?: string
          object_key: string
          object_type: string
          page_number?: number | null
          verified_at?: string | null
          verified_via?: string | null
        }
        Update: {
          bbox_json?: Json | null
          client_id?: string
          confidence?: number
          created_at?: string | null
          document_id?: string
          evidence_page_range?: string | null
          evidence_snippet?: string | null
          field_name?: string
          field_value_json?: Json | null
          field_value_text?: string | null
          id?: string
          is_verified?: boolean
          model_id?: string
          object_key?: string
          object_type?: string
          page_number?: number | null
          verified_at?: string | null
          verified_via?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "observations_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "observations_document_id_fkey"
            columns: ["document_id"]
            isOneToOne: false
            referencedRelation: "documents"
            referencedColumns: ["id"]
          },
        ]
      }
      pitch_drafts: {
        Row: {
          channel: string
          created_at: string | null
          curator_email: string | null
          curator_name: string | null
          dm_content: string | null
          id: string
          instagram_handle: string | null
          model: string | null
          pitch_content: string | null
          playlist_id: string | null
          status: string | null
          updated_at: string | null
        }
        Insert: {
          channel?: string
          created_at?: string | null
          curator_email?: string | null
          curator_name?: string | null
          dm_content?: string | null
          id?: string
          instagram_handle?: string | null
          model?: string | null
          pitch_content?: string | null
          playlist_id?: string | null
          status?: string | null
          updated_at?: string | null
        }
        Update: {
          channel?: string
          created_at?: string | null
          curator_email?: string | null
          curator_name?: string | null
          dm_content?: string | null
          id?: string
          instagram_handle?: string | null
          model?: string | null
          pitch_content?: string | null
          playlist_id?: string | null
          status?: string | null
          updated_at?: string | null
        }
        Relationships: []
      }
      playlist_research: {
        Row: {
          artist_name: string
          created_at: string | null
          genre: string | null
          id: string
          model: string | null
          research: Json
          track_name: string
          updated_at: string | null
        }
        Insert: {
          artist_name: string
          created_at?: string | null
          genre?: string | null
          id?: string
          model?: string | null
          research: Json
          track_name: string
          updated_at?: string | null
        }
        Update: {
          artist_name?: string
          created_at?: string | null
          genre?: string | null
          id?: string
          model?: string | null
          research?: Json
          track_name?: string
          updated_at?: string | null
        }
        Relationships: []
      }
      sessions: {
        Row: {
          active_model: string
          channel: string
          channel_user_id: string
          context: Json
          created_at: string
          id: string
          updated_at: string
        }
        Insert: {
          active_model?: string
          channel?: string
          channel_user_id: string
          context?: Json
          created_at?: string
          id?: string
          updated_at?: string
        }
        Update: {
          active_model?: string
          channel?: string
          channel_user_id?: string
          context?: Json
          created_at?: string
          id?: string
          updated_at?: string
        }
        Relationships: []
      }
      statement_chunk_jobs: {
        Row: {
          attempts: number | null
          chunk_count: number | null
          chunk_size_pages: number
          claimed_at: string | null
          client_id: string
          completed_at: string | null
          created_at: string | null
          extracted_payload: Json | null
          file_id: string
          file_name: string
          file_size_bytes: number | null
          id: string
          last_error: string | null
          pages_failed: number | null
          pages_processed: number | null
          pages_total: number | null
          reason_codes: Json | null
          relative_path: string | null
          source_type: string
          started_at: string | null
          status: string
          tax_year: number
          transactions_extracted: number | null
          updated_at: string | null
          warning_flags: Json | null
        }
        Insert: {
          attempts?: number | null
          chunk_count?: number | null
          chunk_size_pages?: number
          claimed_at?: string | null
          client_id: string
          completed_at?: string | null
          created_at?: string | null
          extracted_payload?: Json | null
          file_id: string
          file_name: string
          file_size_bytes?: number | null
          id?: string
          last_error?: string | null
          pages_failed?: number | null
          pages_processed?: number | null
          pages_total?: number | null
          reason_codes?: Json | null
          relative_path?: string | null
          source_type?: string
          started_at?: string | null
          status?: string
          tax_year: number
          transactions_extracted?: number | null
          updated_at?: string | null
          warning_flags?: Json | null
        }
        Update: {
          attempts?: number | null
          chunk_count?: number | null
          chunk_size_pages?: number
          claimed_at?: string | null
          client_id?: string
          completed_at?: string | null
          created_at?: string | null
          extracted_payload?: Json | null
          file_id?: string
          file_name?: string
          file_size_bytes?: number | null
          id?: string
          last_error?: string | null
          pages_failed?: number | null
          pages_processed?: number | null
          pages_total?: number | null
          reason_codes?: Json | null
          relative_path?: string | null
          source_type?: string
          started_at?: string | null
          status?: string
          tax_year?: number
          transactions_extracted?: number | null
          updated_at?: string | null
          warning_flags?: Json | null
        }
        Relationships: []
      }
      tasks: {
        Row: {
          created_at: string
          error: string | null
          id: string
          request_text: string
          requested_model: string | null
          result_json: Json | null
          selected_tools: Json | null
          selected_workflow: string | null
          session_id: string
          status: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          error?: string | null
          id?: string
          request_text: string
          requested_model?: string | null
          result_json?: Json | null
          selected_tools?: Json | null
          selected_workflow?: string | null
          session_id: string
          status?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          error?: string | null
          id?: string
          request_text?: string
          requested_model?: string | null
          result_json?: Json | null
          selected_tools?: Json | null
          selected_workflow?: string | null
          session_id?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tasks_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      tax_form_instances: {
        Row: {
          created_at: string | null
          drive_file_id: string | null
          error_message: string | null
          field_data: Json | null
          form_type: string
          form_year: number
          id: string
          notes: string | null
          pdf_url: string | null
          status: string | null
          tax_return_id: string
          template_id: string | null
          updated_at: string | null
        }
        Insert: {
          created_at?: string | null
          drive_file_id?: string | null
          error_message?: string | null
          field_data?: Json | null
          form_type: string
          form_year: number
          id?: string
          notes?: string | null
          pdf_url?: string | null
          status?: string | null
          tax_return_id: string
          template_id?: string | null
          updated_at?: string | null
        }
        Update: {
          created_at?: string | null
          drive_file_id?: string | null
          error_message?: string | null
          field_data?: Json | null
          form_type?: string
          form_year?: number
          id?: string
          notes?: string | null
          pdf_url?: string | null
          status?: string | null
          tax_return_id?: string
          template_id?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "tax_form_instances_tax_return_id_fkey"
            columns: ["tax_return_id"]
            isOneToOne: false
            referencedRelation: "tax_returns"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tax_form_instances_template_id_fkey"
            columns: ["template_id"]
            isOneToOne: false
            referencedRelation: "tax_form_templates"
            referencedColumns: ["id"]
          },
        ]
      }
      tax_form_templates: {
        Row: {
          created_at: string | null
          description: string | null
          field_schema: Json | null
          form_name: string
          form_type: string
          form_year: number
          id: string
          is_active: boolean | null
          pdf_template_url: string | null
          updated_at: string | null
        }
        Insert: {
          created_at?: string | null
          description?: string | null
          field_schema?: Json | null
          form_name: string
          form_type: string
          form_year: number
          id?: string
          is_active?: boolean | null
          pdf_template_url?: string | null
          updated_at?: string | null
        }
        Update: {
          created_at?: string | null
          description?: string | null
          field_schema?: Json | null
          form_name?: string
          form_type?: string
          form_year?: number
          id?: string
          is_active?: boolean | null
          pdf_template_url?: string | null
          updated_at?: string | null
        }
        Relationships: []
      }
      tax_return_audit_log: {
        Row: {
          action: string
          actor: string | null
          created_at: string | null
          id: string
          metadata: Json | null
          new_values: Json | null
          old_values: Json | null
          tax_return_id: string
        }
        Insert: {
          action: string
          actor?: string | null
          created_at?: string | null
          id?: string
          metadata?: Json | null
          new_values?: Json | null
          old_values?: Json | null
          tax_return_id: string
        }
        Update: {
          action?: string
          actor?: string | null
          created_at?: string | null
          id?: string
          metadata?: Json | null
          new_values?: Json | null
          old_values?: Json | null
          tax_return_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "tax_return_audit_log_tax_return_id_fkey"
            columns: ["tax_return_id"]
            isOneToOne: false
            referencedRelation: "tax_returns"
            referencedColumns: ["id"]
          },
        ]
      }
      tax_returns: {
        Row: {
          agi: number | null
          amount_owed_or_refund: number | null
          analyzed_data: Json | null
          client_id: string
          client_name: string | null
          confirmation_number: string | null
          created_at: string | null
          created_by: string | null
          drive_folder_id: string | null
          drive_folder_url: string | null
          filed_at: string | null
          filing_method: string | null
          filing_readiness_score: number | null
          filing_recommendation: Json | null
          filing_status: string | null
          id: string
          json_summary: Json | null
          model: string | null
          notes: string | null
          status: string | null
          tax_year: number
          total_income: number | null
          total_tax: number | null
          updated_at: string | null
          worksheet: string | null
          workspace_settings: Json | null
        }
        Insert: {
          agi?: number | null
          amount_owed_or_refund?: number | null
          analyzed_data?: Json | null
          client_id: string
          client_name?: string | null
          confirmation_number?: string | null
          created_at?: string | null
          created_by?: string | null
          drive_folder_id?: string | null
          drive_folder_url?: string | null
          filed_at?: string | null
          filing_method?: string | null
          filing_readiness_score?: number | null
          filing_recommendation?: Json | null
          filing_status?: string | null
          id?: string
          json_summary?: Json | null
          model?: string | null
          notes?: string | null
          status?: string | null
          tax_year: number
          total_income?: number | null
          total_tax?: number | null
          updated_at?: string | null
          worksheet?: string | null
          workspace_settings?: Json | null
        }
        Update: {
          agi?: number | null
          amount_owed_or_refund?: number | null
          analyzed_data?: Json | null
          client_id?: string
          client_name?: string | null
          confirmation_number?: string | null
          created_at?: string | null
          created_by?: string | null
          drive_folder_id?: string | null
          drive_folder_url?: string | null
          filed_at?: string | null
          filing_method?: string | null
          filing_readiness_score?: number | null
          filing_recommendation?: Json | null
          filing_status?: string | null
          id?: string
          json_summary?: Json | null
          model?: string | null
          notes?: string | null
          status?: string | null
          tax_year?: number
          total_income?: number | null
          total_tax?: number | null
          updated_at?: string | null
          worksheet?: string | null
          workspace_settings?: Json | null
        }
        Relationships: []
      }
      telegram_approval_queue: {
        Row: {
          client_id: string
          created_at: string
          document_id: string
          id: string
          observation_count: number
          resolved_at: string | null
          status: string
          telegram_message_id: number | null
        }
        Insert: {
          client_id: string
          created_at?: string
          document_id: string
          id?: string
          observation_count?: number
          resolved_at?: string | null
          status?: string
          telegram_message_id?: number | null
        }
        Update: {
          client_id?: string
          created_at?: string
          document_id?: string
          id?: string
          observation_count?: number
          resolved_at?: string | null
          status?: string
          telegram_message_id?: number | null
        }
        Relationships: []
      }
      telegram_outbox: {
        Row: {
          attempt_count: number
          chat_id: string
          created_at: string
          dedupe_key: string | null
          id: string
          kind: string
          last_attempt_at: string | null
          last_error: string | null
          next_attempt_at: string
          payload: Json
          sent_at: string | null
          status: string
          task_id: string
          updated_at: string
        }
        Insert: {
          attempt_count?: number
          chat_id: string
          created_at?: string
          dedupe_key?: string | null
          id?: string
          kind: string
          last_attempt_at?: string | null
          last_error?: string | null
          next_attempt_at?: string
          payload: Json
          sent_at?: string | null
          status?: string
          task_id: string
          updated_at?: string
        }
        Update: {
          attempt_count?: number
          chat_id?: string
          created_at?: string
          dedupe_key?: string | null
          id?: string
          kind?: string
          last_attempt_at?: string | null
          last_error?: string | null
          next_attempt_at?: string
          payload?: Json
          sent_at?: string | null
          status?: string
          task_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "telegram_outbox_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id"]
          },
        ]
      }
      telegram_webhook_processed_updates: {
        Row: {
          received_at: string
          update_id: number
        }
        Insert: {
          received_at?: string
          update_id: number
        }
        Update: {
          received_at?: string
          update_id?: number
        }
        Relationships: []
      }
      tool_execution_logs: {
        Row: {
          args: Json | null
          chat_id: string | null
          completed_at: string | null
          elapsed_ms: number | null
          error: string | null
          http_status: number | null
          id: string
          model: string | null
          request_id: string
          response_json: Json | null
          started_at: string
          status: string
          tool_name: string
          user_message: string | null
        }
        Insert: {
          args?: Json | null
          chat_id?: string | null
          completed_at?: string | null
          elapsed_ms?: number | null
          error?: string | null
          http_status?: number | null
          id?: string
          model?: string | null
          request_id: string
          response_json?: Json | null
          started_at?: string
          status?: string
          tool_name: string
          user_message?: string | null
        }
        Update: {
          args?: Json | null
          chat_id?: string | null
          completed_at?: string | null
          elapsed_ms?: number | null
          error?: string | null
          http_status?: number | null
          id?: string
          model?: string | null
          request_id?: string
          response_json?: Json | null
          started_at?: string
          status?: string
          tool_name?: string
          user_message?: string | null
        }
        Relationships: []
      }
      workflows: {
        Row: {
          created_at: string
          description: string
          id: string
          key: string
          name: string
          tools: Json
          trigger_phrases: Json
          updated_at: string
        }
        Insert: {
          created_at?: string
          description?: string
          id?: string
          key: string
          name: string
          tools?: Json
          trigger_phrases?: Json
          updated_at?: string
        }
        Update: {
          created_at?: string
          description?: string
          id?: string
          key?: string
          name?: string
          tools?: Json
          trigger_phrases?: Json
          updated_at?: string
        }
        Relationships: []
      }
    }
    Views: {
      current_inquiries: {
        Row: {
          bureau: string | null
          client_id: string | null
          confidence: number | null
          created_at: string | null
          doc_type: string | null
          document_id: string | null
          evidence_page_range: string | null
          evidence_snippet: string | null
          field_name: string | null
          field_value_json: Json | null
          field_value_text: string | null
          id: string | null
          model_id: string | null
          object_key: string | null
          object_type: string | null
          page_number: number | null
        }
        Relationships: [
          {
            foreignKeyName: "observations_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "observations_document_id_fkey"
            columns: ["document_id"]
            isOneToOne: false
            referencedRelation: "documents"
            referencedColumns: ["id"]
          },
        ]
      }
      current_personal_info: {
        Row: {
          bureau: string | null
          client_id: string | null
          confidence: number | null
          created_at: string | null
          doc_type: string | null
          document_id: string | null
          evidence_page_range: string | null
          evidence_snippet: string | null
          field_name: string | null
          field_value_json: Json | null
          field_value_text: string | null
          id: string | null
          model_id: string | null
          object_key: string | null
          object_type: string | null
          page_number: number | null
        }
        Relationships: [
          {
            foreignKeyName: "observations_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "observations_document_id_fkey"
            columns: ["document_id"]
            isOneToOne: false
            referencedRelation: "documents"
            referencedColumns: ["id"]
          },
        ]
      }
      current_tradelines: {
        Row: {
          bureau: string | null
          client_id: string | null
          confidence: number | null
          created_at: string | null
          doc_type: string | null
          document_id: string | null
          evidence_page_range: string | null
          evidence_snippet: string | null
          field_name: string | null
          field_value_json: Json | null
          field_value_text: string | null
          id: string | null
          model_id: string | null
          object_key: string | null
          object_type: string | null
          page_number: number | null
        }
        Relationships: [
          {
            foreignKeyName: "observations_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "observations_document_id_fkey"
            columns: ["document_id"]
            isOneToOne: false
            referencedRelation: "documents"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Functions: {
      claim_outbox_rows: {
        Args: { p_chat_id: string; p_limit: number; p_now: string }
        Returns: {
          attempt_count: number
          id: string
          kind: string
          payload: Json
        }[]
      }
      delete_client_and_related_data: {
        Args: { p_client_id: string }
        Returns: undefined
      }
      list_workflows: {
        Args: never
        Returns: {
          description: string
          key: string
          name: string
          tools: Json
          trigger_phrases: Json
        }[]
      }
      match_credit_knowledge: {
        Args: {
          filter_type?: string
          match_count?: number
          match_threshold?: number
          query_embedding: string
        }
        Returns: {
          content: string
          id: string
          metadata: Json
          similarity: number
          type: string
        }[]
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
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
  public: {
    Enums: {},
  },
} as const
