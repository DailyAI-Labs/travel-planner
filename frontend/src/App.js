import React, { useState, useEffect, useCallback } from 'react';
import './App.css';

function App() {
  // Health check state
  const [healthStatus, setHealthStatus] = useState(null);
  const [healthLoading, setHealthLoading] = useState(false);
  const [healthError, setHealthError] = useState(null);

  // Travel plan state
  const [travelPlanStatus, setTravelPlanStatus] = useState(null);
  const [travelPlanLoading, setTravelPlanLoading] = useState(false);
  const [travelPlanError, setTravelPlanError] = useState(null);
  const [travelPlanResponse, setTravelPlanResponse] = useState(null);
  const [isPolling, setIsPolling] = useState(false);

  // Form state
  const [formData, setFormData] = useState({
    places: '',
    start_idx: 0,
    end_idx: 0,
    start_time: '',
    modes: '',
    walking_preference: false,
    max_walking_distance: 1000
  });

  const checkBackendHealth = async () => {
    setHealthLoading(true);
    setHealthError(null);
    
    try {
      const response = await fetch('http://localhost:8000/health');
      
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      
      const data = await response.json();
      setHealthStatus(data);
    } catch (err) {
      setHealthError(err.message);
      setHealthStatus(null);
    } finally {
      setHealthLoading(false);
    }
  };

  // Function to check travel plan status
  const checkTravelPlanStatus = useCallback(async (code) => {
    try {
      const response = await fetch(`http://localhost:8000/api/v1/travel_plan/${code}`);
      
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      
      const data = await response.json();
      setTravelPlanResponse(data);
      
      // Stop polling if status is completed or failed
      if (data.status === 'completed' || data.status === 'failed') {
        setIsPolling(false);
      }
      
      return data;
    } catch (err) {
      console.error('Error checking travel plan status:', err);
      setTravelPlanError(err.message);
      setIsPolling(false);
      return null;
    }
  }, []);

  // Auto-refresh effect for polling travel plan status
  useEffect(() => {
    let interval;
    
    if (isPolling && travelPlanStatus?.code) {
      // Poll every 3 seconds
      interval = setInterval(() => {
        checkTravelPlanStatus(travelPlanStatus.code);
      }, 3000);
      
      // Also check immediately
      checkTravelPlanStatus(travelPlanStatus.code);
    }
    
    return () => {
      if (interval) {
        clearInterval(interval);
      }
    };
  }, [isPolling, travelPlanStatus?.code, checkTravelPlanStatus]);

  const submitTravelPlan = async (e) => {
    e.preventDefault();
    setTravelPlanLoading(true);
    setTravelPlanError(null);
    setTravelPlanResponse(null);
    
    try {
      // Parse places from comma-separated string
      const placesArray = formData.places.split(',').map(place => place.trim()).filter(place => place);
      
      // Parse modes from comma-separated string
      const modesArray = formData.modes.split(',').map(mode => mode.trim()).filter(mode => mode);
      
      // Prepare request body
      const requestBody = {
        places: placesArray,
        start_idx: parseInt(formData.start_idx),
        end_idx: parseInt(formData.end_idx),
        start_time: new Date(formData.start_time).toISOString(),
        modes: modesArray,
        walking_preference: formData.walking_preference,
        max_walking_distance: parseInt(formData.max_walking_distance)
      };

      const response = await fetch('http://localhost:8000/api/v1/compute_itinerary', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody)
      });
      
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.detail || `HTTP error! status: ${response.status}`);
      }
      
      const data = await response.json();
      setTravelPlanStatus(data);
      
      // Start polling if status is pending
      if (data.status === 'pending') {
        setIsPolling(true);
      }
    } catch (err) {
      setTravelPlanError(err.message);
      setTravelPlanStatus(null);
    } finally {
      setTravelPlanLoading(false);
    }
  };

  const handleInputChange = (e) => {
    const { name, value, type, checked } = e.target;
    setFormData(prev => ({
      ...prev,
      [name]: type === 'checkbox' ? checked : value
    }));
  };

  const stopPolling = () => {
    setIsPolling(false);
  };

  const renderTravelPlanDetails = (plan) => {
    if (!plan) return null;

    return (
      <div className="travel-plan-details">
        <h4>Travel Plan Details</h4>
        
        {plan.itinerary && (
          <div className="itinerary-section">
            <h5>Itinerary:</h5>
            <pre className="json-display">{JSON.stringify(plan.itinerary, null, 2)}</pre>
          </div>
        )}
        
        {plan.total_duration && (
          <p><strong>Total Duration:</strong> {plan.total_duration}</p>
        )}
        
        {plan.total_distance && (
          <p><strong>Total Distance:</strong> {plan.total_distance}</p>
        )}
        
        {plan.error && (
          <div className="error-details">
            <h5>Error Details:</h5>
            <p>{plan.error}</p>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="App">
      <header className="App-header">
        <h1>Travel Planner Dashboard</h1>
        
        {/* Health Check Section */}
        <section className="section">
          <h2>Backend Health Check</h2>
          <button 
            onClick={checkBackendHealth}
            disabled={healthLoading}
            className="health-check-btn"
          >
            {healthLoading ? 'Checking...' : 'Check Backend Status'}
          </button>

          {healthStatus && (
            <div className="status-success">
              <h3>✅ Backend Status</h3>
              <p><strong>Status:</strong> {healthStatus.status}</p>
              <p><strong>Timestamp:</strong> {new Date(healthStatus.timestamp).toLocaleString()}</p>
            </div>
          )}

          {healthError && (
            <div className="status-error">
              <h3>❌ Connection Error</h3>
              <p>{healthError}</p>
            </div>
          )}
        </section>

        {/* Travel Plan Section */}
        <section className="section">
          <h2>Plan Your Journey</h2>
          
          <form onSubmit={submitTravelPlan} className="travel-form">
            <div className="form-group">
              <label htmlFor="places">Places to Visit (comma-separated):</label>
              <input
                type="text"
                id="places"
                name="places"
                value={formData.places}
                onChange={handleInputChange}
                placeholder="Paris, London, Berlin, Rome"
                required
                className="form-input"
              />
            </div>

            <div className="form-row">
              <div className="form-group">
                <label htmlFor="start_idx">Start Place Index:</label>
                <input
                  type="number"
                  id="start_idx"
                  name="start_idx"
                  value={formData.start_idx}
                  onChange={handleInputChange}
                  min="0"
                  required
                  className="form-input"
                />
              </div>

              <div className="form-group">
                <label htmlFor="end_idx">End Place Index:</label>
                <input
                  type="number"
                  id="end_idx"
                  name="end_idx"
                  value={formData.end_idx}
                  onChange={handleInputChange}
                  min="0"
                  required
                  className="form-input"
                />
              </div>
            </div>

            <div className="form-group">
              <label htmlFor="start_time">Start Time:</label>
              <input
                type="datetime-local"
                id="start_time"
                name="start_time"
                value={formData.start_time}
                onChange={handleInputChange}
                required
                className="form-input"
              />
            </div>

            <div className="form-group">
              <label htmlFor="modes">Transportation Modes (comma-separated):</label>
              <input
                type="text"
                id="modes"
                name="modes"
                value={formData.modes}
                onChange={handleInputChange}
                placeholder="walking, public_transport, car"
                required
                className="form-input"
              />
            </div>

            <div className="form-group">
              <label htmlFor="max_walking_distance">Max Walking Distance (meters):</label>
              <input
                type="number"
                id="max_walking_distance"
                name="max_walking_distance"
                value={formData.max_walking_distance}
                onChange={handleInputChange}
                min="0"
                required
                className="form-input"
              />
            </div>

            <div className="form-group checkbox-group">
              <label htmlFor="walking_preference" className="checkbox-label">
                <input
                  type="checkbox"
                  id="walking_preference"
                  name="walking_preference"
                  checked={formData.walking_preference}
                  onChange={handleInputChange}
                  className="checkbox-input"
                />
                Prefer Walking When Possible
              </label>
            </div>

            <button 
              type="submit" 
              disabled={travelPlanLoading}
              className="submit-btn"
            >
              {travelPlanLoading ? 'Computing...' : 'Compute Itinerary'}
            </button>
          </form>

          {/* Travel Plan Initial Status */}
          {travelPlanStatus && (
            <div className="status-info">
              <h3>📋 Travel Plan Request</h3>
              <p><strong>Code:</strong> {travelPlanStatus.code}</p>
              <p><strong>Initial Status:</strong> {travelPlanStatus.status}</p>
              <p><strong>Message:</strong> {travelPlanStatus.message}</p>
            </div>
          )}

          {/* Polling Status */}
          {isPolling && (
            <div className="status-polling">
              <h3>🔄 Checking Status...</h3>
              <p>Auto-refreshing every 3 seconds</p>
              <button onClick={stopPolling} className="stop-polling-btn">
                Stop Checking
              </button>
            </div>
          )}

          {/* Travel Plan Response */}
          {travelPlanResponse && (
            <div className={`status-response ${travelPlanResponse.status === 'completed' ? 'status-success' : 
                                              travelPlanResponse.status === 'failed' ? 'status-error' : 'status-processing'}`}>
              <h3>
                {travelPlanResponse.status === 'completed' && '✅ Travel Plan Completed!'}
                {travelPlanResponse.status === 'failed' && '❌ Travel Plan Failed'}
                {travelPlanResponse.status === 'processing' && '⏳ Processing...'}
                {travelPlanResponse.status === 'pending' && '⏸️ Pending...'}
              </h3>
              <p><strong>Status:</strong> {travelPlanResponse.status}</p>
              <p><strong>Message:</strong> {travelPlanResponse.message}</p>
              <p><strong>Last Updated:</strong> {new Date().toLocaleString()}</p>
              
              {travelPlanResponse.status === 'completed' && renderTravelPlanDetails(travelPlanResponse)}
            </div>
          )}

          {travelPlanError && (
            <div className="status-error">
              <h3>❌ Travel Plan Error</h3>
              <p>{travelPlanError}</p>
            </div>
          )}
        </section>
      </header>
    </div>
  );
}

export default App;
