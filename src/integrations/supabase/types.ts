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
      muse_access_audit: {
        Row: {
          at: string
          http_status: number
          id: number
          ip_hash: string | null
          method: string
          note: string | null
          resource: string
          token_label: string | null
          user_agent: string | null
        }
        Insert: {
          at?: string
          http_status: number
          id?: number
          ip_hash?: string | null
          method: string
          note?: string | null
          resource: string
          token_label?: string | null
          user_agent?: string | null
        }
        Update: {
          at?: string
          http_status?: number
          id?: number
          ip_hash?: string | null
          method?: string
          note?: string | null
          resource?: string
          token_label?: string | null
          user_agent?: string | null
        }
        Relationships: []
      }
      muse_api_tokens: {
        Row: {
          created_at: string
          expires_at: string | null
          id: string
          label: string
          last_used_at: string | null
          notes: string | null
          revoked_at: string | null
          scopes: string[]
          token_sha256: string
        }
        Insert: {
          created_at?: string
          expires_at?: string | null
          id?: string
          label: string
          last_used_at?: string | null
          notes?: string | null
          revoked_at?: string | null
          scopes?: string[]
          token_sha256: string
        }
        Update: {
          created_at?: string
          expires_at?: string | null
          id?: string
          label?: string
          last_used_at?: string | null
          notes?: string | null
          revoked_at?: string | null
          scopes?: string[]
          token_sha256?: string
        }
        Relationships: []
      }
      muse_decisions: {
        Row: {
          classification: string
          context: string | null
          created_at: string
          decided_at: string | null
          decision: string | null
          decision_required_by: string | null
          domain_key: string
          evidence: Json
          id: string
          options: Json
          owner: string
          question: string
          review_at: string | null
          source: string
          source_ref: string | null
          status: string
          updated_at: string
        }
        Insert: {
          classification?: string
          context?: string | null
          created_at?: string
          decided_at?: string | null
          decision?: string | null
          decision_required_by?: string | null
          domain_key: string
          evidence?: Json
          id?: string
          options?: Json
          owner?: string
          question: string
          review_at?: string | null
          source?: string
          source_ref?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          classification?: string
          context?: string | null
          created_at?: string
          decided_at?: string | null
          decision?: string | null
          decision_required_by?: string | null
          domain_key?: string
          evidence?: Json
          id?: string
          options?: Json
          owner?: string
          question?: string
          review_at?: string | null
          source?: string
          source_ref?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "muse_decisions_domain_key_fkey"
            columns: ["domain_key"]
            isOneToOne: false
            referencedRelation: "muse_domains"
            referencedColumns: ["key"]
          },
          {
            foreignKeyName: "muse_decisions_domain_key_fkey"
            columns: ["domain_key"]
            isOneToOne: false
            referencedRelation: "muse_portfolio_map"
            referencedColumns: ["domain_key"]
          },
        ]
      }
      muse_domains: {
        Row: {
          created_at: string
          current_bottleneck: string | null
          current_initiative: string | null
          data_status: string
          is_active: boolean
          key: string
          name: string
          next_review_at: string | null
          notes: string | null
          owner: string
          sort_order: number
          source_of_truth: string | null
          status: string
          systems: Json
          updated_at: string
        }
        Insert: {
          created_at?: string
          current_bottleneck?: string | null
          current_initiative?: string | null
          data_status?: string
          is_active?: boolean
          key: string
          name: string
          next_review_at?: string | null
          notes?: string | null
          owner?: string
          sort_order?: number
          source_of_truth?: string | null
          status?: string
          systems?: Json
          updated_at?: string
        }
        Update: {
          created_at?: string
          current_bottleneck?: string | null
          current_initiative?: string | null
          data_status?: string
          is_active?: boolean
          key?: string
          name?: string
          next_review_at?: string | null
          notes?: string | null
          owner?: string
          sort_order?: number
          source_of_truth?: string | null
          status?: string
          systems?: Json
          updated_at?: string
        }
        Relationships: []
      }
      muse_improvement_measurements: {
        Row: {
          created_at: string
          delta_text: string | null
          evidence_ref: string | null
          financial_impact: number | null
          id: string
          improvement_id: string
          measured_at: string
          measurement_type: string
          metric: string
          notes: string | null
          time_saved_minutes: number | null
          unintended_consequences: string | null
          unit: string | null
          value_numeric: number | null
          value_text: string | null
          verification_state: string
        }
        Insert: {
          created_at?: string
          delta_text?: string | null
          evidence_ref?: string | null
          financial_impact?: number | null
          id?: string
          improvement_id: string
          measured_at?: string
          measurement_type: string
          metric: string
          notes?: string | null
          time_saved_minutes?: number | null
          unintended_consequences?: string | null
          unit?: string | null
          value_numeric?: number | null
          value_text?: string | null
          verification_state?: string
        }
        Update: {
          created_at?: string
          delta_text?: string | null
          evidence_ref?: string | null
          financial_impact?: number | null
          id?: string
          improvement_id?: string
          measured_at?: string
          measurement_type?: string
          metric?: string
          notes?: string | null
          time_saved_minutes?: number | null
          unintended_consequences?: string | null
          unit?: string | null
          value_numeric?: number | null
          value_text?: string | null
          verification_state?: string
        }
        Relationships: [
          {
            foreignKeyName: "muse_improvement_measurements_improvement_id_fkey"
            columns: ["improvement_id"]
            isOneToOne: false
            referencedRelation: "muse_daily_improvement_board"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "muse_improvement_measurements_improvement_id_fkey"
            columns: ["improvement_id"]
            isOneToOne: false
            referencedRelation: "muse_improvement_ledger"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "muse_improvement_measurements_improvement_id_fkey"
            columns: ["improvement_id"]
            isOneToOne: false
            referencedRelation: "muse_improvement_results"
            referencedColumns: ["improvement_id"]
          },
          {
            foreignKeyName: "muse_improvement_measurements_improvement_id_fkey"
            columns: ["improvement_id"]
            isOneToOne: false
            referencedRelation: "muse_improvements"
            referencedColumns: ["id"]
          },
        ]
      }
      muse_improvement_tasks: {
        Row: {
          assigning_agent: string
          blocker: string | null
          claimed_completed_at: string | null
          created_at: string
          definition_of_done: string | null
          domain_key: string
          due_at: string | null
          evidence: Json
          executor: string
          expected_artifact: string | null
          id: string
          improvement_id: string
          instructions: string | null
          objective: string | null
          priority: string
          source_ref: string | null
          state: string
          title: string
          updated_at: string
          verification_state: string
        }
        Insert: {
          assigning_agent?: string
          blocker?: string | null
          claimed_completed_at?: string | null
          created_at?: string
          definition_of_done?: string | null
          domain_key: string
          due_at?: string | null
          evidence?: Json
          executor: string
          expected_artifact?: string | null
          id?: string
          improvement_id: string
          instructions?: string | null
          objective?: string | null
          priority?: string
          source_ref?: string | null
          state?: string
          title: string
          updated_at?: string
          verification_state?: string
        }
        Update: {
          assigning_agent?: string
          blocker?: string | null
          claimed_completed_at?: string | null
          created_at?: string
          definition_of_done?: string | null
          domain_key?: string
          due_at?: string | null
          evidence?: Json
          executor?: string
          expected_artifact?: string | null
          id?: string
          improvement_id?: string
          instructions?: string | null
          objective?: string | null
          priority?: string
          source_ref?: string | null
          state?: string
          title?: string
          updated_at?: string
          verification_state?: string
        }
        Relationships: [
          {
            foreignKeyName: "muse_improvement_tasks_domain_key_fkey"
            columns: ["domain_key"]
            isOneToOne: false
            referencedRelation: "muse_domains"
            referencedColumns: ["key"]
          },
          {
            foreignKeyName: "muse_improvement_tasks_domain_key_fkey"
            columns: ["domain_key"]
            isOneToOne: false
            referencedRelation: "muse_portfolio_map"
            referencedColumns: ["domain_key"]
          },
          {
            foreignKeyName: "muse_improvement_tasks_improvement_id_fkey"
            columns: ["improvement_id"]
            isOneToOne: false
            referencedRelation: "muse_daily_improvement_board"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "muse_improvement_tasks_improvement_id_fkey"
            columns: ["improvement_id"]
            isOneToOne: false
            referencedRelation: "muse_improvement_ledger"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "muse_improvement_tasks_improvement_id_fkey"
            columns: ["improvement_id"]
            isOneToOne: false
            referencedRelation: "muse_improvement_results"
            referencedColumns: ["improvement_id"]
          },
          {
            foreignKeyName: "muse_improvement_tasks_improvement_id_fkey"
            columns: ["improvement_id"]
            isOneToOne: false
            referencedRelation: "muse_improvements"
            referencedColumns: ["id"]
          },
        ]
      }
      muse_improvements: {
        Row: {
          actual_result: string | null
          baseline: string | null
          confidence: string | null
          created_at: string
          definition_of_done: string | null
          domain_key: string
          expected_impact: string | null
          expected_result: string | null
          function_name: string | null
          hypothesis: string | null
          id: string
          improvement_date: string | null
          intervention: string
          metric: string
          mission_id: string | null
          notes: string | null
          observation: string | null
          observe_only_reason: string | null
          owner: string
          owner_attention: string | null
          priority: string | null
          problem: string
          recommended_executor: string | null
          reversible: boolean | null
          review_at: string | null
          risk: string | null
          selected_by: string | null
          source_ref: string | null
          started_at: string | null
          status: string
          updated_at: string
          verdict: string
          verification_requirement: string | null
          verification_state: string
        }
        Insert: {
          actual_result?: string | null
          baseline?: string | null
          confidence?: string | null
          created_at?: string
          definition_of_done?: string | null
          domain_key: string
          expected_impact?: string | null
          expected_result?: string | null
          function_name?: string | null
          hypothesis?: string | null
          id?: string
          improvement_date?: string | null
          intervention: string
          metric: string
          mission_id?: string | null
          notes?: string | null
          observation?: string | null
          observe_only_reason?: string | null
          owner?: string
          owner_attention?: string | null
          priority?: string | null
          problem: string
          recommended_executor?: string | null
          reversible?: boolean | null
          review_at?: string | null
          risk?: string | null
          selected_by?: string | null
          source_ref?: string | null
          started_at?: string | null
          status?: string
          updated_at?: string
          verdict?: string
          verification_requirement?: string | null
          verification_state?: string
        }
        Update: {
          actual_result?: string | null
          baseline?: string | null
          confidence?: string | null
          created_at?: string
          definition_of_done?: string | null
          domain_key?: string
          expected_impact?: string | null
          expected_result?: string | null
          function_name?: string | null
          hypothesis?: string | null
          id?: string
          improvement_date?: string | null
          intervention?: string
          metric?: string
          mission_id?: string | null
          notes?: string | null
          observation?: string | null
          observe_only_reason?: string | null
          owner?: string
          owner_attention?: string | null
          priority?: string | null
          problem?: string
          recommended_executor?: string | null
          reversible?: boolean | null
          review_at?: string | null
          risk?: string | null
          selected_by?: string | null
          source_ref?: string | null
          started_at?: string | null
          status?: string
          updated_at?: string
          verdict?: string
          verification_requirement?: string | null
          verification_state?: string
        }
        Relationships: [
          {
            foreignKeyName: "muse_improvements_domain_key_fkey"
            columns: ["domain_key"]
            isOneToOne: false
            referencedRelation: "muse_domains"
            referencedColumns: ["key"]
          },
          {
            foreignKeyName: "muse_improvements_domain_key_fkey"
            columns: ["domain_key"]
            isOneToOne: false
            referencedRelation: "muse_portfolio_map"
            referencedColumns: ["domain_key"]
          },
          {
            foreignKeyName: "muse_improvements_mission_id_fkey"
            columns: ["mission_id"]
            isOneToOne: false
            referencedRelation: "muse_mission_board"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "muse_improvements_mission_id_fkey"
            columns: ["mission_id"]
            isOneToOne: false
            referencedRelation: "muse_missions"
            referencedColumns: ["id"]
          },
        ]
      }
      muse_kpi_registry: {
        Row: {
          created_at: string
          data_status: string
          direction: string
          domain_key: string
          is_derived: boolean
          is_primary: boolean
          metric_key: string
          name: string
          notes: string | null
          sort_order: number
          source_system: string
          target: string | null
          unit: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          data_status?: string
          direction?: string
          domain_key: string
          is_derived?: boolean
          is_primary?: boolean
          metric_key: string
          name: string
          notes?: string | null
          sort_order?: number
          source_system: string
          target?: string | null
          unit?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          data_status?: string
          direction?: string
          domain_key?: string
          is_derived?: boolean
          is_primary?: boolean
          metric_key?: string
          name?: string
          notes?: string | null
          sort_order?: number
          source_system?: string
          target?: string | null
          unit?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "muse_kpi_registry_domain_key_fkey"
            columns: ["domain_key"]
            isOneToOne: false
            referencedRelation: "muse_domains"
            referencedColumns: ["key"]
          },
          {
            foreignKeyName: "muse_kpi_registry_domain_key_fkey"
            columns: ["domain_key"]
            isOneToOne: false
            referencedRelation: "muse_portfolio_map"
            referencedColumns: ["domain_key"]
          },
        ]
      }
      muse_missions: {
        Row: {
          baseline: string | null
          business_outcome: string | null
          created_at: string
          created_by: string
          dependencies: Json
          domain_key: string
          executive_sponsor: string
          id: string
          metric: string | null
          notes: string | null
          objective: string
          owner: string
          priority: string
          review_at: string | null
          source_ref: string | null
          started_at: string | null
          status: string
          target: string | null
          title: string
          updated_at: string
        }
        Insert: {
          baseline?: string | null
          business_outcome?: string | null
          created_at?: string
          created_by?: string
          dependencies?: Json
          domain_key: string
          executive_sponsor?: string
          id?: string
          metric?: string | null
          notes?: string | null
          objective: string
          owner?: string
          priority?: string
          review_at?: string | null
          source_ref?: string | null
          started_at?: string | null
          status?: string
          target?: string | null
          title: string
          updated_at?: string
        }
        Update: {
          baseline?: string | null
          business_outcome?: string | null
          created_at?: string
          created_by?: string
          dependencies?: Json
          domain_key?: string
          executive_sponsor?: string
          id?: string
          metric?: string | null
          notes?: string | null
          objective?: string
          owner?: string
          priority?: string
          review_at?: string | null
          source_ref?: string | null
          started_at?: string | null
          status?: string
          target?: string | null
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "muse_missions_domain_key_fkey"
            columns: ["domain_key"]
            isOneToOne: false
            referencedRelation: "muse_domains"
            referencedColumns: ["key"]
          },
          {
            foreignKeyName: "muse_missions_domain_key_fkey"
            columns: ["domain_key"]
            isOneToOne: false
            referencedRelation: "muse_portfolio_map"
            referencedColumns: ["domain_key"]
          },
        ]
      }
      muse_open_loops: {
        Row: {
          category: string
          classification: string
          created_at: string
          dependency: string | null
          derive_resolution_from: string | null
          domain_key: string
          id: string
          last_evidence_at: string | null
          next_action: string | null
          notes: string | null
          owner: string | null
          priority: string
          resolved_at: string | null
          review_at: string | null
          source: string
          source_ref: string | null
          state: string
          title: string
          updated_at: string
          verification_state: string
        }
        Insert: {
          category?: string
          classification?: string
          created_at?: string
          dependency?: string | null
          derive_resolution_from?: string | null
          domain_key: string
          id?: string
          last_evidence_at?: string | null
          next_action?: string | null
          notes?: string | null
          owner?: string | null
          priority?: string
          resolved_at?: string | null
          review_at?: string | null
          source?: string
          source_ref?: string | null
          state?: string
          title: string
          updated_at?: string
          verification_state?: string
        }
        Update: {
          category?: string
          classification?: string
          created_at?: string
          dependency?: string | null
          derive_resolution_from?: string | null
          domain_key?: string
          id?: string
          last_evidence_at?: string | null
          next_action?: string | null
          notes?: string | null
          owner?: string | null
          priority?: string
          resolved_at?: string | null
          review_at?: string | null
          source?: string
          source_ref?: string | null
          state?: string
          title?: string
          updated_at?: string
          verification_state?: string
        }
        Relationships: [
          {
            foreignKeyName: "muse_open_loops_domain_key_fkey"
            columns: ["domain_key"]
            isOneToOne: false
            referencedRelation: "muse_domains"
            referencedColumns: ["key"]
          },
          {
            foreignKeyName: "muse_open_loops_domain_key_fkey"
            columns: ["domain_key"]
            isOneToOne: false
            referencedRelation: "muse_portfolio_map"
            referencedColumns: ["domain_key"]
          },
        ]
      }
      muse_source_authority: {
        Row: {
          access_status: string
          authoritative_system: string
          confidence: string
          created_at: string
          domain_key: string
          freshness_target_minutes: number | null
          id: string
          known_conflict: boolean
          last_verified_at: string | null
          notes: string | null
          reference: string | null
          secondary_system: string | null
          subject: string
          updated_at: string
        }
        Insert: {
          access_status?: string
          authoritative_system: string
          confidence?: string
          created_at?: string
          domain_key: string
          freshness_target_minutes?: number | null
          id?: string
          known_conflict?: boolean
          last_verified_at?: string | null
          notes?: string | null
          reference?: string | null
          secondary_system?: string | null
          subject: string
          updated_at?: string
        }
        Update: {
          access_status?: string
          authoritative_system?: string
          confidence?: string
          created_at?: string
          domain_key?: string
          freshness_target_minutes?: number | null
          id?: string
          known_conflict?: boolean
          last_verified_at?: string | null
          notes?: string | null
          reference?: string | null
          secondary_system?: string | null
          subject?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "muse_source_authority_domain_key_fkey"
            columns: ["domain_key"]
            isOneToOne: false
            referencedRelation: "muse_domains"
            referencedColumns: ["key"]
          },
          {
            foreignKeyName: "muse_source_authority_domain_key_fkey"
            columns: ["domain_key"]
            isOneToOne: false
            referencedRelation: "muse_portfolio_map"
            referencedColumns: ["domain_key"]
          },
        ]
      }
      muse_source_conflicts: {
        Row: {
          candidate_authority: string | null
          created_at: string
          detected_at: string
          domain_key: string
          id: string
          reference_a: string | null
          reference_b: string | null
          resolution_notes: string | null
          resolved_at: string | null
          status: string
          subject: string
          system_a: string
          system_b: string
          updated_at: string
          value_a: string
          value_b: string
        }
        Insert: {
          candidate_authority?: string | null
          created_at?: string
          detected_at?: string
          domain_key: string
          id?: string
          reference_a?: string | null
          reference_b?: string | null
          resolution_notes?: string | null
          resolved_at?: string | null
          status?: string
          subject: string
          system_a: string
          system_b: string
          updated_at?: string
          value_a: string
          value_b: string
        }
        Update: {
          candidate_authority?: string | null
          created_at?: string
          detected_at?: string
          domain_key?: string
          id?: string
          reference_a?: string | null
          reference_b?: string | null
          resolution_notes?: string | null
          resolved_at?: string | null
          status?: string
          subject?: string
          system_a?: string
          system_b?: string
          updated_at?: string
          value_a?: string
          value_b?: string
        }
        Relationships: [
          {
            foreignKeyName: "muse_source_conflicts_domain_key_fkey"
            columns: ["domain_key"]
            isOneToOne: false
            referencedRelation: "muse_domains"
            referencedColumns: ["key"]
          },
          {
            foreignKeyName: "muse_source_conflicts_domain_key_fkey"
            columns: ["domain_key"]
            isOneToOne: false
            referencedRelation: "muse_portfolio_map"
            referencedColumns: ["domain_key"]
          },
        ]
      }
      muse_systems: {
        Row: {
          blocker: string | null
          cadence_minutes: number | null
          created_at: string
          data_status: string
          domain_key: string | null
          downstream_impact: string | null
          expected_cadence: string
          is_active: boolean
          key: string
          name: string
          notes: string | null
          owner_type: string
          probe_key: string | null
          role: string
          sort_order: number
          updated_at: string
          waits_on_human: boolean
        }
        Insert: {
          blocker?: string | null
          cadence_minutes?: number | null
          created_at?: string
          data_status?: string
          domain_key?: string | null
          downstream_impact?: string | null
          expected_cadence?: string
          is_active?: boolean
          key: string
          name: string
          notes?: string | null
          owner_type?: string
          probe_key?: string | null
          role: string
          sort_order?: number
          updated_at?: string
          waits_on_human?: boolean
        }
        Update: {
          blocker?: string | null
          cadence_minutes?: number | null
          created_at?: string
          data_status?: string
          domain_key?: string | null
          downstream_impact?: string | null
          expected_cadence?: string
          is_active?: boolean
          key?: string
          name?: string
          notes?: string | null
          owner_type?: string
          probe_key?: string | null
          role?: string
          sort_order?: number
          updated_at?: string
          waits_on_human?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "muse_systems_domain_key_fkey"
            columns: ["domain_key"]
            isOneToOne: false
            referencedRelation: "muse_domains"
            referencedColumns: ["key"]
          },
          {
            foreignKeyName: "muse_systems_domain_key_fkey"
            columns: ["domain_key"]
            isOneToOne: false
            referencedRelation: "muse_portfolio_map"
            referencedColumns: ["domain_key"]
          },
        ]
      }
      muse_verifications: {
        Row: {
          branch: string | null
          claim: string
          claimed_at: string
          claimed_by: string | null
          commit_sha: string | null
          created_at: string
          evidence_url: string | null
          id: string
          notes: string | null
          repo: string | null
          subject_ref: string
          subject_type: string
          updated_at: string
          verification_state: string
          verified_at: string | null
          verified_by: string | null
        }
        Insert: {
          branch?: string | null
          claim: string
          claimed_at?: string
          claimed_by?: string | null
          commit_sha?: string | null
          created_at?: string
          evidence_url?: string | null
          id?: string
          notes?: string | null
          repo?: string | null
          subject_ref: string
          subject_type: string
          updated_at?: string
          verification_state?: string
          verified_at?: string | null
          verified_by?: string | null
        }
        Update: {
          branch?: string | null
          claim?: string
          claimed_at?: string
          claimed_by?: string | null
          commit_sha?: string | null
          created_at?: string
          evidence_url?: string | null
          id?: string
          notes?: string | null
          repo?: string | null
          subject_ref?: string
          subject_type?: string
          updated_at?: string
          verification_state?: string
          verified_at?: string | null
          verified_by?: string | null
        }
        Relationships: []
      }
      muse_work_updates: {
        Row: {
          actor: string
          created_at: string
          domain_key: string | null
          evidence_ref: string | null
          id: string
          improvement_id: string | null
          message: string
          mission_id: string | null
          task_id: string | null
          update_type: string
        }
        Insert: {
          actor: string
          created_at?: string
          domain_key?: string | null
          evidence_ref?: string | null
          id?: string
          improvement_id?: string | null
          message: string
          mission_id?: string | null
          task_id?: string | null
          update_type: string
        }
        Update: {
          actor?: string
          created_at?: string
          domain_key?: string | null
          evidence_ref?: string | null
          id?: string
          improvement_id?: string | null
          message?: string
          mission_id?: string | null
          task_id?: string | null
          update_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "muse_work_updates_domain_key_fkey"
            columns: ["domain_key"]
            isOneToOne: false
            referencedRelation: "muse_domains"
            referencedColumns: ["key"]
          },
          {
            foreignKeyName: "muse_work_updates_domain_key_fkey"
            columns: ["domain_key"]
            isOneToOne: false
            referencedRelation: "muse_portfolio_map"
            referencedColumns: ["domain_key"]
          },
          {
            foreignKeyName: "muse_work_updates_improvement_id_fkey"
            columns: ["improvement_id"]
            isOneToOne: false
            referencedRelation: "muse_daily_improvement_board"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "muse_work_updates_improvement_id_fkey"
            columns: ["improvement_id"]
            isOneToOne: false
            referencedRelation: "muse_improvement_ledger"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "muse_work_updates_improvement_id_fkey"
            columns: ["improvement_id"]
            isOneToOne: false
            referencedRelation: "muse_improvement_results"
            referencedColumns: ["improvement_id"]
          },
          {
            foreignKeyName: "muse_work_updates_improvement_id_fkey"
            columns: ["improvement_id"]
            isOneToOne: false
            referencedRelation: "muse_improvements"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "muse_work_updates_mission_id_fkey"
            columns: ["mission_id"]
            isOneToOne: false
            referencedRelation: "muse_mission_board"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "muse_work_updates_mission_id_fkey"
            columns: ["mission_id"]
            isOneToOne: false
            referencedRelation: "muse_missions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "muse_work_updates_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "muse_agent_queue"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "muse_work_updates_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "muse_improvement_tasks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "muse_work_updates_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "muse_verification_queue"
            referencedColumns: ["task_id"]
          },
        ]
      }
      muse_workboard_requests: {
        Row: {
          action: string
          created_at: string
          http_status: number
          id: string
          request_key: string
          response: Json
          token_label: string
        }
        Insert: {
          action: string
          created_at?: string
          http_status: number
          id?: string
          request_key: string
          response?: Json
          token_label: string
        }
        Update: {
          action?: string
          created_at?: string
          http_status?: number
          id?: string
          request_key?: string
          response?: Json
          token_label?: string
        }
        Relationships: []
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
      pending_guardian_events: {
        Row: {
          bureau: string
          bureau_canonical: string
          cg_client_id: string | null
          clarification_needed: Json | null
          client_name: string
          correlation_id: string
          created_at: string
          delivered_at: string | null
          delivery_error: string | null
          drive_file_id: string
          drive_file_name: string
          drive_path: string
          error_message: string | null
          event_type: string
          file_unique_id: string
          guardian_event_id: string | null
          id: string
          next_retry_at: string | null
          ocr_text: string | null
          received_at: string
          retry_count: number
          round: number | null
          source: string
          status: string
          updated_at: string
        }
        Insert: {
          bureau: string
          bureau_canonical: string
          cg_client_id?: string | null
          clarification_needed?: Json | null
          client_name: string
          correlation_id: string
          created_at?: string
          delivered_at?: string | null
          delivery_error?: string | null
          drive_file_id: string
          drive_file_name: string
          drive_path: string
          error_message?: string | null
          event_type: string
          file_unique_id: string
          guardian_event_id?: string | null
          id?: string
          next_retry_at?: string | null
          ocr_text?: string | null
          received_at?: string
          retry_count?: number
          round?: number | null
          source: string
          status?: string
          updated_at?: string
        }
        Update: {
          bureau?: string
          bureau_canonical?: string
          cg_client_id?: string | null
          clarification_needed?: Json | null
          client_name?: string
          correlation_id?: string
          created_at?: string
          delivered_at?: string | null
          delivery_error?: string | null
          drive_file_id?: string
          drive_file_name?: string
          drive_path?: string
          error_message?: string | null
          event_type?: string
          file_unique_id?: string
          guardian_event_id?: string | null
          id?: string
          next_retry_at?: string | null
          ocr_text?: string | null
          received_at?: string
          retry_count?: number
          round?: number | null
          source?: string
          status?: string
          updated_at?: string
        }
        Relationships: []
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
      remote_bridge_devices: {
        Row: {
          capabilities: Json
          created_at: string
          device_name: string
          id: string
          last_seen_at: string | null
          status: string
          updated_at: string
        }
        Insert: {
          capabilities?: Json
          created_at?: string
          device_name: string
          id?: string
          last_seen_at?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          capabilities?: Json
          created_at?: string
          device_name?: string
          id?: string
          last_seen_at?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: []
      }
      remote_command_queue: {
        Row: {
          claimed_at: string | null
          command_type: string
          completed_at: string | null
          created_at: string
          device_id: string | null
          error: string | null
          expires_at: string
          id: string
          payload: Json
          reply_chat_id: string | null
          result_json: Json | null
          source: string
          source_ref: string | null
          status: string
          updated_at: string
        }
        Insert: {
          claimed_at?: string | null
          command_type: string
          completed_at?: string | null
          created_at?: string
          device_id?: string | null
          error?: string | null
          expires_at?: string
          id?: string
          payload?: Json
          reply_chat_id?: string | null
          result_json?: Json | null
          source?: string
          source_ref?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          claimed_at?: string | null
          command_type?: string
          completed_at?: string | null
          created_at?: string
          device_id?: string | null
          error?: string | null
          expires_at?: string
          id?: string
          payload?: Json
          reply_chat_id?: string | null
          result_json?: Json | null
          source?: string
          source_ref?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "remote_command_queue_device_id_fkey"
            columns: ["device_id"]
            isOneToOne: false
            referencedRelation: "remote_bridge_devices"
            referencedColumns: ["id"]
          },
        ]
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
          callback_received_at: string | null
          callback_token_hash: string | null
          chunk_count: number | null
          chunk_size_pages: number
          claimed_at: string | null
          client_id: string
          completed_at: string | null
          created_at: string | null
          external_attempts: number
          external_endpoint: string | null
          external_job_id: string | null
          external_last_error: string | null
          external_provider: string | null
          external_status: string | null
          extracted_payload: Json | null
          file_id: string
          file_name: string
          file_size_bytes: number | null
          finalized_by: string | null
          id: string
          last_error: string | null
          next_retry_at: string | null
          pages_failed: number | null
          pages_processed: number | null
          pages_total: number | null
          prep_completed_at: string | null
          prep_error: string | null
          prep_started_at: string | null
          prep_status: string
          processing_mode: string
          processor_version: string | null
          reason_codes: Json | null
          relative_path: string | null
          source_bytes: number | null
          source_drive_file_id: string | null
          source_storage_bucket: string | null
          source_storage_path: string | null
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
          callback_received_at?: string | null
          callback_token_hash?: string | null
          chunk_count?: number | null
          chunk_size_pages?: number
          claimed_at?: string | null
          client_id: string
          completed_at?: string | null
          created_at?: string | null
          external_attempts?: number
          external_endpoint?: string | null
          external_job_id?: string | null
          external_last_error?: string | null
          external_provider?: string | null
          external_status?: string | null
          extracted_payload?: Json | null
          file_id: string
          file_name: string
          file_size_bytes?: number | null
          finalized_by?: string | null
          id?: string
          last_error?: string | null
          next_retry_at?: string | null
          pages_failed?: number | null
          pages_processed?: number | null
          pages_total?: number | null
          prep_completed_at?: string | null
          prep_error?: string | null
          prep_started_at?: string | null
          prep_status?: string
          processing_mode?: string
          processor_version?: string | null
          reason_codes?: Json | null
          relative_path?: string | null
          source_bytes?: number | null
          source_drive_file_id?: string | null
          source_storage_bucket?: string | null
          source_storage_path?: string | null
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
          callback_received_at?: string | null
          callback_token_hash?: string | null
          chunk_count?: number | null
          chunk_size_pages?: number
          claimed_at?: string | null
          client_id?: string
          completed_at?: string | null
          created_at?: string | null
          external_attempts?: number
          external_endpoint?: string | null
          external_job_id?: string | null
          external_last_error?: string | null
          external_provider?: string | null
          external_status?: string | null
          extracted_payload?: Json | null
          file_id?: string
          file_name?: string
          file_size_bytes?: number | null
          finalized_by?: string | null
          id?: string
          last_error?: string | null
          next_retry_at?: string | null
          pages_failed?: number | null
          pages_processed?: number | null
          pages_total?: number | null
          prep_completed_at?: string | null
          prep_error?: string | null
          prep_started_at?: string | null
          prep_status?: string
          processing_mode?: string
          processor_version?: string | null
          reason_codes?: Json | null
          relative_path?: string | null
          source_bytes?: number | null
          source_drive_file_id?: string | null
          source_storage_bucket?: string | null
          source_storage_path?: string | null
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
      workflow_runs: {
        Row: {
          client_id: string | null
          client_name: string | null
          created_at: string
          current_stage: string
          error: Json | null
          id: string
          intent: string
          last_error: string | null
          locked_state: Json | null
          result_payload: Json | null
          statement_job_ids: Json | null
          status: string
          tax_year: number | null
          updated_at: string
        }
        Insert: {
          client_id?: string | null
          client_name?: string | null
          created_at?: string
          current_stage?: string
          error?: Json | null
          id?: string
          intent: string
          last_error?: string | null
          locked_state?: Json | null
          result_payload?: Json | null
          statement_job_ids?: Json | null
          status?: string
          tax_year?: number | null
          updated_at?: string
        }
        Update: {
          client_id?: string | null
          client_name?: string | null
          created_at?: string
          current_stage?: string
          error?: Json | null
          id?: string
          intent?: string
          last_error?: string | null
          locked_state?: Json | null
          result_payload?: Json | null
          statement_job_ids?: Json | null
          status?: string
          tax_year?: number | null
          updated_at?: string
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
      muse_agent_queue: {
        Row: {
          as_of: string | null
          assigning_agent: string | null
          blocker: string | null
          claimed_completed_at: string | null
          created_at: string | null
          definition_of_done: string | null
          domain_key: string | null
          domain_name: string | null
          due_at: string | null
          evidence: Json | null
          executor: string | null
          expected_artifact: string | null
          id: string | null
          improvement: string | null
          improvement_id: string | null
          instructions: string | null
          objective: string | null
          overdue: boolean | null
          priority: string | null
          source_ref: string | null
          state: string | null
          title: string | null
          updated_at: string | null
          verification_state: string | null
        }
        Relationships: [
          {
            foreignKeyName: "muse_improvement_tasks_domain_key_fkey"
            columns: ["domain_key"]
            isOneToOne: false
            referencedRelation: "muse_domains"
            referencedColumns: ["key"]
          },
          {
            foreignKeyName: "muse_improvement_tasks_domain_key_fkey"
            columns: ["domain_key"]
            isOneToOne: false
            referencedRelation: "muse_portfolio_map"
            referencedColumns: ["domain_key"]
          },
          {
            foreignKeyName: "muse_improvement_tasks_improvement_id_fkey"
            columns: ["improvement_id"]
            isOneToOne: false
            referencedRelation: "muse_daily_improvement_board"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "muse_improvement_tasks_improvement_id_fkey"
            columns: ["improvement_id"]
            isOneToOne: false
            referencedRelation: "muse_improvement_ledger"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "muse_improvement_tasks_improvement_id_fkey"
            columns: ["improvement_id"]
            isOneToOne: false
            referencedRelation: "muse_improvement_results"
            referencedColumns: ["improvement_id"]
          },
          {
            foreignKeyName: "muse_improvement_tasks_improvement_id_fkey"
            columns: ["improvement_id"]
            isOneToOne: false
            referencedRelation: "muse_improvements"
            referencedColumns: ["id"]
          },
        ]
      }
      muse_daily_improvement_board: {
        Row: {
          actual_result: string | null
          as_of: string | null
          baseline: string | null
          confidence: string | null
          created_at: string | null
          definition_of_done: string | null
          domain_key: string | null
          domain_name: string | null
          expected_impact: string | null
          expected_result: string | null
          function_name: string | null
          hypothesis: string | null
          id: string | null
          improvement_date: string | null
          intervention: string | null
          measurement_count: number | null
          metric: string | null
          mission_id: string | null
          mission_title: string | null
          notes: string | null
          observation: string | null
          observe_only_reason: string | null
          owner: string | null
          owner_attention: string | null
          priority: string | null
          problem: string | null
          recommended_executor: string | null
          reversible: boolean | null
          review_at: string | null
          review_due: boolean | null
          risk: string | null
          selected_by: string | null
          source_ref: string | null
          started_at: string | null
          status: string | null
          task_count: number | null
          tasks_blocked: number | null
          tasks_complete: number | null
          verdict: string | null
          verification_requirement: string | null
          verification_state: string | null
        }
        Relationships: [
          {
            foreignKeyName: "muse_improvements_domain_key_fkey"
            columns: ["domain_key"]
            isOneToOne: false
            referencedRelation: "muse_domains"
            referencedColumns: ["key"]
          },
          {
            foreignKeyName: "muse_improvements_domain_key_fkey"
            columns: ["domain_key"]
            isOneToOne: false
            referencedRelation: "muse_portfolio_map"
            referencedColumns: ["domain_key"]
          },
          {
            foreignKeyName: "muse_improvements_mission_id_fkey"
            columns: ["mission_id"]
            isOneToOne: false
            referencedRelation: "muse_mission_board"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "muse_improvements_mission_id_fkey"
            columns: ["mission_id"]
            isOneToOne: false
            referencedRelation: "muse_missions"
            referencedColumns: ["id"]
          },
        ]
      }
      muse_decisions_required: {
        Row: {
          as_of: string | null
          classification: string | null
          context: string | null
          created_at: string | null
          days_remaining: number | null
          decision_required_by: string | null
          domain_key: string | null
          domain_name: string | null
          evidence: Json | null
          id: string | null
          options: Json | null
          overdue: boolean | null
          owner: string | null
          question: string | null
          review_at: string | null
          source: string | null
          source_ref: string | null
          status: string | null
        }
        Relationships: [
          {
            foreignKeyName: "muse_decisions_domain_key_fkey"
            columns: ["domain_key"]
            isOneToOne: false
            referencedRelation: "muse_domains"
            referencedColumns: ["key"]
          },
          {
            foreignKeyName: "muse_decisions_domain_key_fkey"
            columns: ["domain_key"]
            isOneToOne: false
            referencedRelation: "muse_portfolio_map"
            referencedColumns: ["domain_key"]
          },
        ]
      }
      muse_executive_brief: {
        Row: {
          as_of: string | null
          classification: string | null
          data_status: string | null
          detail: string | null
          domain_key: string | null
          domain_name: string | null
          due_at: string | null
          item_id: string | null
          item_type: string | null
          owner: string | null
          rank: number | null
          section: string | null
          source: string | null
          source_ref: string | null
          title: string | null
          verification_state: string | null
        }
        Relationships: []
      }
      muse_improvement_ledger: {
        Row: {
          actual_result: string | null
          as_of: string | null
          awaiting_measurement: boolean | null
          baseline: string | null
          created_at: string | null
          data_status: string | null
          domain_key: string | null
          domain_name: string | null
          expected_result: string | null
          id: string | null
          intervention: string | null
          metric: string | null
          notes: string | null
          owner: string | null
          problem: string | null
          review_at: string | null
          review_due: boolean | null
          source_ref: string | null
          started_at: string | null
          status: string | null
          verdict: string | null
          verification_state: string | null
        }
        Relationships: [
          {
            foreignKeyName: "muse_improvements_domain_key_fkey"
            columns: ["domain_key"]
            isOneToOne: false
            referencedRelation: "muse_domains"
            referencedColumns: ["key"]
          },
          {
            foreignKeyName: "muse_improvements_domain_key_fkey"
            columns: ["domain_key"]
            isOneToOne: false
            referencedRelation: "muse_portfolio_map"
            referencedColumns: ["domain_key"]
          },
        ]
      }
      muse_improvement_results: {
        Row: {
          actual_result: string | null
          as_of: string | null
          baseline: string | null
          domain_key: string | null
          domain_name: string | null
          improvement_id: string | null
          intervention: string | null
          latest_delta: string | null
          latest_measurement_at: string | null
          latest_measurement_type: string | null
          latest_value: string | null
          measurement_count: number | null
          metric: string | null
          recorded_financial_impact: number | null
          recorded_time_saved_minutes: number | null
          review_at: string | null
          started_at: string | null
          status: string | null
          verdict: string | null
          verification_state: string | null
        }
        Relationships: [
          {
            foreignKeyName: "muse_improvements_domain_key_fkey"
            columns: ["domain_key"]
            isOneToOne: false
            referencedRelation: "muse_domains"
            referencedColumns: ["key"]
          },
          {
            foreignKeyName: "muse_improvements_domain_key_fkey"
            columns: ["domain_key"]
            isOneToOne: false
            referencedRelation: "muse_portfolio_map"
            referencedColumns: ["domain_key"]
          },
        ]
      }
      muse_kpi_derived: {
        Row: {
          data_timestamp: string | null
          metric_key: string | null
          source_table: string | null
          value: number | null
        }
        Relationships: []
      }
      muse_kpi_summary: {
        Row: {
          as_of: string | null
          confidence: string | null
          data_status: string | null
          data_timestamp: string | null
          direction: string | null
          domain_key: string | null
          domain_name: string | null
          evidence_ref: string | null
          human_verification_required: boolean | null
          is_primary: boolean | null
          metric_key: string | null
          name: string | null
          notes: string | null
          sort_order: number | null
          source_system: string | null
          target: string | null
          unit: string | null
          value: number | null
        }
        Relationships: [
          {
            foreignKeyName: "muse_kpi_registry_domain_key_fkey"
            columns: ["domain_key"]
            isOneToOne: false
            referencedRelation: "muse_domains"
            referencedColumns: ["key"]
          },
          {
            foreignKeyName: "muse_kpi_registry_domain_key_fkey"
            columns: ["domain_key"]
            isOneToOne: false
            referencedRelation: "muse_portfolio_map"
            referencedColumns: ["domain_key"]
          },
        ]
      }
      muse_mission_board: {
        Row: {
          active_improvements: number | null
          active_tasks: number | null
          as_of: string | null
          baseline: string | null
          blocked_tasks: number | null
          business_outcome: string | null
          created_at: string | null
          created_by: string | null
          dependencies: Json | null
          domain_key: string | null
          domain_name: string | null
          executive_sponsor: string | null
          id: string | null
          metric: string | null
          notes: string | null
          objective: string | null
          owner: string | null
          priority: string | null
          review_at: string | null
          source_ref: string | null
          started_at: string | null
          status: string | null
          target: string | null
          title: string | null
          updated_at: string | null
        }
        Relationships: [
          {
            foreignKeyName: "muse_missions_domain_key_fkey"
            columns: ["domain_key"]
            isOneToOne: false
            referencedRelation: "muse_domains"
            referencedColumns: ["key"]
          },
          {
            foreignKeyName: "muse_missions_domain_key_fkey"
            columns: ["domain_key"]
            isOneToOne: false
            referencedRelation: "muse_portfolio_map"
            referencedColumns: ["domain_key"]
          },
        ]
      }
      muse_open_loops_live: {
        Row: {
          as_of: string | null
          category: string | null
          classification: string | null
          data_status: string | null
          dependency: string | null
          derive_resolution_from: string | null
          derived_system_status: string | null
          domain_key: string | null
          domain_name: string | null
          evidence_stale: boolean | null
          id: string | null
          last_evidence_at: string | null
          next_action: string | null
          notes: string | null
          owner: string | null
          priority: string | null
          resolved_at: string | null
          review_at: string | null
          review_overdue: boolean | null
          source: string | null
          source_ref: string | null
          state: string | null
          stored_state: string | null
          title: string | null
          verification_state: string | null
        }
        Relationships: [
          {
            foreignKeyName: "muse_open_loops_domain_key_fkey"
            columns: ["domain_key"]
            isOneToOne: false
            referencedRelation: "muse_domains"
            referencedColumns: ["key"]
          },
          {
            foreignKeyName: "muse_open_loops_domain_key_fkey"
            columns: ["domain_key"]
            isOneToOne: false
            referencedRelation: "muse_portfolio_map"
            referencedColumns: ["domain_key"]
          },
        ]
      }
      muse_portfolio_map: {
        Row: {
          active_improvements: number | null
          as_of: string | null
          blocked_loops: number | null
          current_bottleneck: string | null
          current_initiative: string | null
          data_status: string | null
          decisions_pending: number | null
          domain_key: string | null
          name: string | null
          next_review_at: string | null
          notes: string | null
          open_conflicts: number | null
          open_loops: number | null
          owner: string | null
          primary_kpi_at: string | null
          primary_kpi_name: string | null
          primary_kpi_status: string | null
          primary_kpi_unit: string | null
          primary_kpi_value: number | null
          sort_order: number | null
          source_of_truth: string | null
          sources_last_verified_at: string | null
          status: string | null
          systems: Json | null
          unhealthy_systems: number | null
        }
        Insert: {
          active_improvements?: never
          as_of?: never
          blocked_loops?: never
          current_bottleneck?: string | null
          current_initiative?: string | null
          data_status?: string | null
          decisions_pending?: never
          domain_key?: string | null
          name?: string | null
          next_review_at?: string | null
          notes?: string | null
          open_conflicts?: never
          open_loops?: never
          owner?: string | null
          primary_kpi_at?: never
          primary_kpi_name?: never
          primary_kpi_status?: never
          primary_kpi_unit?: never
          primary_kpi_value?: never
          sort_order?: number | null
          source_of_truth?: string | null
          sources_last_verified_at?: never
          status?: string | null
          systems?: Json | null
          unhealthy_systems?: never
        }
        Update: {
          active_improvements?: never
          as_of?: never
          blocked_loops?: never
          current_bottleneck?: string | null
          current_initiative?: string | null
          data_status?: string | null
          decisions_pending?: never
          domain_key?: string | null
          name?: string | null
          next_review_at?: string | null
          notes?: string | null
          open_conflicts?: never
          open_loops?: never
          owner?: string | null
          primary_kpi_at?: never
          primary_kpi_name?: never
          primary_kpi_status?: never
          primary_kpi_unit?: never
          primary_kpi_value?: never
          sort_order?: number | null
          source_of_truth?: string | null
          sources_last_verified_at?: never
          status?: string | null
          systems?: Json | null
          unhealthy_systems?: never
        }
        Relationships: []
      }
      muse_source_authority_state: {
        Row: {
          access_status: string | null
          as_of: string | null
          authoritative_system: string | null
          confidence: string | null
          domain_key: string | null
          domain_name: string | null
          freshness: string | null
          freshness_target_minutes: number | null
          human_verification_required: boolean | null
          id: string | null
          known_conflict: boolean | null
          last_verified_at: string | null
          minutes_since_verified: number | null
          notes: string | null
          open_conflicts: number | null
          reference: string | null
          secondary_system: string | null
          subject: string | null
        }
        Relationships: [
          {
            foreignKeyName: "muse_source_authority_domain_key_fkey"
            columns: ["domain_key"]
            isOneToOne: false
            referencedRelation: "muse_domains"
            referencedColumns: ["key"]
          },
          {
            foreignKeyName: "muse_source_authority_domain_key_fkey"
            columns: ["domain_key"]
            isOneToOne: false
            referencedRelation: "muse_portfolio_map"
            referencedColumns: ["domain_key"]
          },
        ]
      }
      muse_source_conflicts_open: {
        Row: {
          as_of: string | null
          candidate_authority: string | null
          data_status: string | null
          detected_at: string | null
          domain_key: string | null
          domain_name: string | null
          human_verification_required: boolean | null
          id: string | null
          reference_a: string | null
          reference_b: string | null
          resolution_notes: string | null
          resolved_at: string | null
          status: string | null
          subject: string | null
          system_a: string | null
          system_b: string | null
          value_a: string | null
          value_b: string | null
        }
        Relationships: [
          {
            foreignKeyName: "muse_source_conflicts_domain_key_fkey"
            columns: ["domain_key"]
            isOneToOne: false
            referencedRelation: "muse_domains"
            referencedColumns: ["key"]
          },
          {
            foreignKeyName: "muse_source_conflicts_domain_key_fkey"
            columns: ["domain_key"]
            isOneToOne: false
            referencedRelation: "muse_portfolio_map"
            referencedColumns: ["domain_key"]
          },
        ]
      }
      muse_system_health: {
        Row: {
          as_of: string | null
          blocker: string | null
          cadence_minutes: number | null
          classification: string | null
          data_status: string | null
          domain_key: string | null
          downstream_impact: string | null
          expected_cadence: string | null
          failing_count: number | null
          last_failure_at: string | null
          last_failure_detail: string | null
          last_success_at: string | null
          latest_activity_at: string | null
          name: string | null
          notes: string | null
          pending_count: number | null
          probe_key: string | null
          role: string | null
          sort_order: number | null
          status: string | null
          system_key: string | null
          waits_on_human: boolean | null
        }
        Relationships: [
          {
            foreignKeyName: "muse_systems_domain_key_fkey"
            columns: ["domain_key"]
            isOneToOne: false
            referencedRelation: "muse_domains"
            referencedColumns: ["key"]
          },
          {
            foreignKeyName: "muse_systems_domain_key_fkey"
            columns: ["domain_key"]
            isOneToOne: false
            referencedRelation: "muse_portfolio_map"
            referencedColumns: ["domain_key"]
          },
        ]
      }
      muse_system_probe: {
        Row: {
          failing_count: number | null
          last_failure_at: string | null
          last_failure_detail: string | null
          last_success_at: string | null
          latest_activity_at: string | null
          pending_count: number | null
          probe_key: string | null
        }
        Relationships: []
      }
      muse_verification_queue: {
        Row: {
          as_of: string | null
          claimant: string | null
          claimed_completed_at: string | null
          definition_of_done: string | null
          domain_key: string | null
          domain_name: string | null
          evidence: Json | null
          expected_artifact: string | null
          improvement_id: string | null
          source_ref: string | null
          task_id: string | null
          title: string | null
          verification_requirement: string | null
          verification_state: string | null
        }
        Relationships: [
          {
            foreignKeyName: "muse_improvement_tasks_domain_key_fkey"
            columns: ["domain_key"]
            isOneToOne: false
            referencedRelation: "muse_domains"
            referencedColumns: ["key"]
          },
          {
            foreignKeyName: "muse_improvement_tasks_domain_key_fkey"
            columns: ["domain_key"]
            isOneToOne: false
            referencedRelation: "muse_portfolio_map"
            referencedColumns: ["domain_key"]
          },
          {
            foreignKeyName: "muse_improvement_tasks_improvement_id_fkey"
            columns: ["improvement_id"]
            isOneToOne: false
            referencedRelation: "muse_daily_improvement_board"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "muse_improvement_tasks_improvement_id_fkey"
            columns: ["improvement_id"]
            isOneToOne: false
            referencedRelation: "muse_improvement_ledger"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "muse_improvement_tasks_improvement_id_fkey"
            columns: ["improvement_id"]
            isOneToOne: false
            referencedRelation: "muse_improvement_results"
            referencedColumns: ["improvement_id"]
          },
          {
            foreignKeyName: "muse_improvement_tasks_improvement_id_fkey"
            columns: ["improvement_id"]
            isOneToOne: false
            referencedRelation: "muse_improvements"
            referencedColumns: ["id"]
          },
        ]
      }
      muse_work_feed: {
        Row: {
          actor: string | null
          as_of: string | null
          created_at: string | null
          domain_key: string | null
          domain_name: string | null
          evidence_ref: string | null
          id: string | null
          improvement_id: string | null
          message: string | null
          mission_id: string | null
          task_id: string | null
          update_type: string | null
        }
        Relationships: [
          {
            foreignKeyName: "muse_work_updates_domain_key_fkey"
            columns: ["domain_key"]
            isOneToOne: false
            referencedRelation: "muse_domains"
            referencedColumns: ["key"]
          },
          {
            foreignKeyName: "muse_work_updates_domain_key_fkey"
            columns: ["domain_key"]
            isOneToOne: false
            referencedRelation: "muse_portfolio_map"
            referencedColumns: ["domain_key"]
          },
          {
            foreignKeyName: "muse_work_updates_improvement_id_fkey"
            columns: ["improvement_id"]
            isOneToOne: false
            referencedRelation: "muse_daily_improvement_board"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "muse_work_updates_improvement_id_fkey"
            columns: ["improvement_id"]
            isOneToOne: false
            referencedRelation: "muse_improvement_ledger"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "muse_work_updates_improvement_id_fkey"
            columns: ["improvement_id"]
            isOneToOne: false
            referencedRelation: "muse_improvement_results"
            referencedColumns: ["improvement_id"]
          },
          {
            foreignKeyName: "muse_work_updates_improvement_id_fkey"
            columns: ["improvement_id"]
            isOneToOne: false
            referencedRelation: "muse_improvements"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "muse_work_updates_mission_id_fkey"
            columns: ["mission_id"]
            isOneToOne: false
            referencedRelation: "muse_mission_board"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "muse_work_updates_mission_id_fkey"
            columns: ["mission_id"]
            isOneToOne: false
            referencedRelation: "muse_missions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "muse_work_updates_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "muse_agent_queue"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "muse_work_updates_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "muse_improvement_tasks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "muse_work_updates_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "muse_verification_queue"
            referencedColumns: ["task_id"]
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
      claim_pending_guardian_events: {
        Args: { p_limit: number; p_now: string }
        Returns: {
          bureau: string
          bureau_canonical: string
          cg_client_id: string
          client_name: string
          correlation_id: string
          drive_file_id: string
          drive_file_name: string
          drive_path: string
          event_type: string
          file_unique_id: string
          id: string
          ocr_text: string
          retry_count: number
          round: number
          source: string
        }[]
      }
      claim_remote_command_rows: {
        Args: { p_device_id: string; p_limit: number; p_now: string }
        Returns: {
          command_type: string
          id: string
          payload: Json
          reply_chat_id: string
          source: string
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
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
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
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
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
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
